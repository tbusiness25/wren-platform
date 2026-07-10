'use strict';

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const schema = () => process.env.PG_SCHEMA || 'demo_secondary';
const db     = () => getPool();

// ── Helpers ──────────────────────────────────────────────────────────────────

const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

// ── Periods ──────────────────────────────────────────────────────────────────

router.get('/periods', authenticate, async (req, res) => {
  const s = schema();
  try {
    const { rows } = await db().query(
      `SELECT * FROM ${s}.timetable_periods ORDER BY week_pattern, day_of_week, period_num`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Subjects, rooms, groups ───────────────────────────────────────────────────

router.get('/subjects', authenticate, async (req, res) => {
  const s = schema();
  try {
    const { rows } = await db().query(`SELECT * FROM ${s}.subjects ORDER BY name`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/rooms', authenticate, async (req, res) => {
  const s = schema();
  try {
    const { rows } = await db().query(`SELECT * FROM ${s}.rooms ORDER BY code, name`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/groups', authenticate, async (req, res) => {
  const s = schema();
  try {
    const { rows } = await db().query(
      `SELECT tg.*, sub.name AS subject_name
       FROM ${s}.teaching_groups tg
       LEFT JOIN ${s}.subjects sub ON sub.id = tg.subject_id
       ORDER BY tg.year_group, tg.code`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/classes', authenticate, async (req, res) => {
  const s = schema();
  try {
    const { rows } = await db().query(`SELECT * FROM ${s}.classes ORDER BY year_group, code, name`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Activities (week view) ───────────────────────────────────────────────────

router.get('/activities', authenticate, async (req, res) => {
  const s = schema();
  const { week_pattern = 1, teacher_id, class_id, year_group, room_id, subject_id } = req.query;
  const where = [`a.week_pattern = $1`];
  const vals  = [parseInt(week_pattern) || 1];

  if (teacher_id)  { vals.push(parseInt(teacher_id));  where.push(`a.teacher_id = $${vals.length}`); }
  if (class_id)    { vals.push(parseInt(class_id));    where.push(`a.class_id = $${vals.length}`); }
  if (year_group)  { vals.push(parseInt(year_group));  where.push(`a.year_group = $${vals.length}`); }
  if (room_id)     { vals.push(parseInt(room_id));     where.push(`a.room_id = $${vals.length}`); }
  if (subject_id)  { vals.push(parseInt(subject_id));  where.push(`a.subject_id = $${vals.length}`); }

  try {
    const { rows } = await db().query(`
      SELECT a.*,
             p.label       AS period_label,
             p.start_time  AS period_start,
             p.end_time    AS period_end,
             p.period_num,
             p.is_break,
             p.is_lunch,
             r.code        AS room_code_ref,
             r.capacity    AS room_capacity,
             sub.name      AS subject_name_ref,
             cls.name      AS class_name
      FROM ${s}.timetable_activities a
      LEFT JOIN ${s}.timetable_periods p  ON p.id = a.period_id
      LEFT JOIN ${s}.rooms r             ON r.id = a.room_id
      LEFT JOIN ${s}.subjects sub        ON sub.id = a.subject_id
      LEFT JOIN ${s}.classes cls         ON cls.id = a.class_id
      WHERE ${where.join(' AND ')}
        AND (p.is_break IS NOT TRUE AND p.is_lunch IS NOT TRUE)
      ORDER BY a.day_of_week, p.period_num
    `, vals);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Teacher's own timetable (teachers can see own; managers see any)
router.get('/activities/teacher/:id', authenticate, async (req, res) => {
  const s = schema();
  const teacherId = parseInt(req.params.id);
  const adminRoles = ['manager','deputy_manager','headteacher','deputy_headteacher','admin'];
  if (!adminRoles.includes(req.user.role) && req.user.id !== teacherId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const wp = parseInt(req.query.week_pattern) || 1;
  try {
    const { rows } = await db().query(`
      SELECT a.*,
             p.label AS period_label, p.start_time, p.end_time, p.period_num,
             p.is_break, p.is_lunch,
             sub.name AS subject_name_ref,
             cls.name AS class_name,
             r.code   AS room_code_ref
      FROM ${s}.timetable_activities a
      LEFT JOIN ${s}.timetable_periods p ON p.id = a.period_id
      LEFT JOIN ${s}.subjects sub        ON sub.id = a.subject_id
      LEFT JOIN ${s}.classes cls         ON cls.id = a.class_id
      LEFT JOIN ${s}.rooms r             ON r.id = a.room_id
      WHERE a.teacher_id = $1 AND a.week_pattern = $2
        AND (p.is_break IS NOT TRUE AND p.is_lunch IS NOT TRUE)
      ORDER BY a.day_of_week, p.period_num
    `, [teacherId, wp]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Import ───────────────────────────────────────────────────────────────────

router.post('/import', requireRole('manager', 'deputy_manager', 'headteacher', 'deputy_headteacher'), upload.single('file'), async (req, res) => {
  const s           = schema();
  const source_kind = (req.body.source_kind || 'generic-csv').trim();
  const week_pattern = parseInt(req.body.week_pattern) || 1;
  const clear_batch  = req.body.clear_existing === 'true';

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let importer;
  try {
    switch (source_kind) {
      case 'timetabler':     importer = require('../lib/importers/timetabler');    break;
      case 'edval':          importer = require('../lib/importers/edval');          break;
      case 'asctimetables':  importer = require('../lib/importers/asctimetables'); break;
      default:               importer = require('../lib/importers/timetabler');    break;
    }
  } catch (e) {
    return res.status(500).json({ error: 'Importer not available: ' + e.message });
  }

  const text = req.file.buffer.toString('utf8').replace(/^﻿/, ''); // strip BOM

  let parsed;
  try {
    parsed = importer.parse(text, { week_pattern });
  } catch (e) {
    return res.status(400).json({ error: 'Parse error: ' + e.message });
  }

  const batchId   = require('crypto').randomUUID();
  const client    = await db().connect();

  try {
    await client.query('BEGIN');

    if (clear_batch) {
      await client.query(`DELETE FROM ${s}.timetable_activities WHERE week_pattern=$1`, [week_pattern]);
    }

    let inserted = 0, skipped = 0;
    const errors = [];

    for (const [i, row] of parsed.entries()) {
      try {
        // Resolve or create period
        const pRes = await client.query(
          `SELECT id FROM ${s}.timetable_periods WHERE week_pattern=$1 AND day_of_week=$2 AND period_num=$3 LIMIT 1`,
          [week_pattern, row.day_of_week, row.period_num]
        );
        const periodId = pRes.rows[0]?.id ?? null;

        // Resolve subject
        let subjectId = null, subjectName = row.subject_name || null;
        if (row.subject_code) {
          const sRes = await client.query(
            `SELECT id, name FROM ${s}.subjects WHERE upper(code)=upper($1) LIMIT 1`, [row.subject_code]);
          if (sRes.rows[0]) { subjectId = sRes.rows[0].id; subjectName = sRes.rows[0].name; }
        }
        if (!subjectId && row.subject_name) {
          const sRes = await client.query(
            `SELECT id FROM ${s}.subjects WHERE lower(name)=lower($1) LIMIT 1`, [row.subject_name]);
          subjectId = sRes.rows[0]?.id ?? null;
        }

        // Resolve room
        let roomId = null, roomCode = row.room_code || null;
        if (row.room_code) {
          const rRes = await client.query(
            `SELECT id FROM ${s}.rooms WHERE upper(code)=upper($1) LIMIT 1`, [row.room_code]);
          roomId = rRes.rows[0]?.id ?? null;
        }

        // Resolve class
        let classId = null;
        if (row.class_name) {
          const cRes = await client.query(
            `SELECT id FROM ${s}.classes WHERE upper(name)=upper($1) OR upper(code)=upper($1) LIMIT 1`,
            [row.class_name]);
          classId = cRes.rows[0]?.id ?? null;
        }

        // Resolve teacher by name — UK timetabling tools use "Surname Initial" or "Surname FirstName"
        let teacherId = null, teacherName = row.teacher_name || null;
        if (row.teacher_name) {
          const parts = row.teacher_name.trim().split(/[\s,]+/).filter(Boolean);

          if (parts.length >= 2) {
            // Strategy 1: "Surname Initial/FirstName" (most common UK format: Richards A, Watson B)
            const r1 = await client.query(
              `SELECT id, first_name||' '||last_name AS name FROM ${s}.staff
               WHERE lower(last_name)=lower($1)
                 AND (lower(first_name)=lower($2) OR lower(left(first_name,1))=lower($2))
                 AND is_active=true LIMIT 1`,
              [parts[0], parts[parts.length - 1]]
            );
            if (r1.rows[0]) { teacherId = r1.rows[0].id; teacherName = r1.rows[0].name; }

            // Strategy 2: "FirstName Surname" (some tools export full name)
            if (!teacherId) {
              const r2 = await client.query(
                `SELECT id, first_name||' '||last_name AS name FROM ${s}.staff
                 WHERE lower(last_name)=lower($1)
                   AND (lower(first_name)=lower($2) OR lower(left(first_name,1))=lower($2))
                   AND is_active=true LIMIT 1`,
                [parts[parts.length - 1], parts[0]]
              );
              if (r2.rows[0]) { teacherId = r2.rows[0].id; teacherName = r2.rows[0].name; }
            }
          }

          // Strategy 3: any part as surname fallback
          if (!teacherId) {
            for (const part of parts) {
              if (part.length < 2) continue;
              const r3 = await client.query(
                `SELECT id, first_name||' '||last_name AS name FROM ${s}.staff
                 WHERE lower(last_name)=lower($1) AND is_active=true LIMIT 1`, [part]);
              if (r3.rows[0]) { teacherId = r3.rows[0].id; teacherName = r3.rows[0].name; break; }
            }
          }
        }

        // Resolve teaching group
        let groupId = null;
        if (row.group_code) {
          const gRes = await client.query(
            `SELECT id FROM ${s}.teaching_groups WHERE upper(code)=upper($1) LIMIT 1`, [row.group_code]);
          if (!gRes.rows[0]) {
            const gIns = await client.query(
              `INSERT INTO ${s}.teaching_groups(code, name, subject_id, year_group)
               VALUES($1,$2,$3,$4) ON CONFLICT(code) DO NOTHING RETURNING id`,
              [row.group_code, row.group_code, subjectId, row.year_group || null]
            );
            groupId = gIns.rows[0]?.id ?? null;
          } else {
            groupId = gRes.rows[0].id;
          }
        }

        await client.query(`
          INSERT INTO ${s}.timetable_activities
            (source_kind, import_batch, week_pattern, day_of_week, period_id, year_group,
             subject_id, group_id, class_id, teacher_id, room_id,
             teacher_name, subject_name, room_code, pupil_count, notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        `, [
          source_kind, batchId, week_pattern, row.day_of_week, periodId,
          row.year_group || null, subjectId, groupId, classId, teacherId, roomId,
          teacherName, subjectName, roomCode, row.pupil_count || null, row.notes || null
        ]);
        inserted++;
      } catch (err) {
        errors.push({ row: i + 1, error: err.message });
        skipped++;
      }
    }

    await client.query('COMMIT');
    res.json({ inserted, skipped, errors, batch_id: batchId, total: parsed.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── Cover: mark absent + get affected periods + suggestions ──────────────────

router.post('/absent', requireRole('manager', 'deputy_manager', 'headteacher', 'deputy_headteacher'), async (req, res) => {
  const s = schema();
  const { teacher_id, dates, absence_reason } = req.body;
  if (!teacher_id || !dates?.length) {
    return res.status(400).json({ error: 'teacher_id and dates[] required' });
  }

  try {
    // Day-of-week for each date
    const affected = [];
    for (const dateStr of dates) {
      const d = new Date(dateStr);
      if (isNaN(d)) continue;
      // JS getDay(): 0=Sun, 1=Mon...5=Fri, 6=Sat
      const dow = d.getDay();
      if (dow < 1 || dow > 5) continue;

      // Fetch activities for this teacher on this day (both week patterns — manager picks which)
      const { rows: activities } = await db().query(`
        SELECT a.*,
               p.label AS period_label, p.period_num, p.start_time, p.end_time,
               sub.name AS subject_name_ref,
               cls.name AS class_name,
               r.code   AS room_code_ref
        FROM ${s}.timetable_activities a
        LEFT JOIN ${s}.timetable_periods p ON p.id = a.period_id
        LEFT JOIN ${s}.subjects sub        ON sub.id = a.subject_id
        LEFT JOIN ${s}.classes cls         ON cls.id = a.class_id
        LEFT JOIN ${s}.rooms r             ON r.id = a.room_id
        WHERE a.teacher_id = $1 AND a.day_of_week = $2
          AND (p.is_break IS NOT TRUE AND p.is_lunch IS NOT TRUE)
        ORDER BY a.week_pattern, p.period_num
      `, [teacher_id, dow]);

      // For each activity get cover suggestions
      const periodsWithSuggestions = await Promise.all(activities.map(async act => {
        const suggestions = await _coverSuggestions(s, act, d);
        return { activity: act, date: dateStr, suggestions };
      }));

      affected.push({ date: dateStr, day_of_week: dow, day_name: DAY_NAMES[dow], periods: periodsWithSuggestions });
    }

    res.json({ teacher_id, absence_reason: absence_reason || null, affected });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function _coverSuggestions(s, activity, coverDate) {
  const dow = coverDate.getDay();
  try {
    // All active teachers except the absent one
    const { rows: staff } = await db().query(`
      SELECT s.id, s.first_name || ' ' || s.last_name AS name
      FROM ${s}.staff s
      WHERE s.is_active = true AND s.id != $1
      ORDER BY s.last_name, s.first_name
    `, [activity.teacher_id]);

    const results = [];

    for (const t of staff) {
      let score = 0;
      const reasons = [];

      // +3 subject match — check if this teacher regularly teaches the same subject
      if (activity.subject_id) {
        const { rows: subMatch } = await db().query(`
          SELECT COUNT(*)::int AS cnt FROM ${s}.timetable_activities
          WHERE teacher_id=$1 AND subject_id=$2
        `, [t.id, activity.subject_id]);
        if (subMatch[0].cnt > 0) { score += 3; reasons.push('subject match'); }
      }

      // +2 free this period (not in timetable)
      const { rows: clash } = await db().query(`
        SELECT COUNT(*)::int AS cnt FROM ${s}.timetable_activities
        WHERE teacher_id=$1 AND day_of_week=$2 AND period_id=$3 AND week_pattern=$4
      `, [t.id, dow, activity.period_id, activity.week_pattern]);
      const isFree = clash[0].cnt === 0;
      if (isFree) { score += 2; reasons.push('free period'); }

      // Check not already covering something this period on this date
      const { rows: covClash } = await db().query(`
        SELECT COUNT(*)::int AS cnt FROM ${s}.timetable_cover
        WHERE cover_teacher_id=$1 AND cover_date=$2 AND activity_id IN (
          SELECT id FROM ${s}.timetable_activities WHERE period_id=$3
        )
      `, [t.id, coverDate.toISOString().slice(0,10), activity.period_id]);
      if (covClash[0].cnt > 0) { score -= 3; } // already covering

      // +1 fewest cover periods this term
      const termStart = new Date(coverDate);
      termStart.setMonth(termStart.getMonth() - 3);
      const { rows: coverCount } = await db().query(`
        SELECT COUNT(*)::int AS cnt FROM ${s}.timetable_cover
        WHERE cover_teacher_id=$1 AND cover_date >= $2
      `, [t.id, termStart.toISOString().slice(0,10)]);
      if (coverCount[0].cnt < 5) { score += 1; reasons.push('fair load'); }

      // +1 has previously taught this group
      if (activity.class_id) {
        const { rows: prev } = await db().query(`
          SELECT COUNT(*)::int AS cnt FROM ${s}.timetable_activities
          WHERE teacher_id=$1 AND class_id=$2 AND subject_id=$3
        `, [t.id, activity.class_id, activity.subject_id]);
        if (prev[0].cnt > 0) { score += 1; reasons.push('knows group'); }
      }

      results.push({ id: t.id, name: t.name, score, reasons, is_free: isFree,
                     cover_count_this_term: coverCount[0].cnt });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 5);
  } catch { return []; }
}

// ── Cover: assign ─────────────────────────────────────────────────────────────

router.post('/cover', requireRole('manager', 'deputy_manager', 'headteacher', 'deputy_headteacher'), async (req, res) => {
  const s = schema();
  const { activity_id, cover_date, absent_teacher_id, cover_teacher_id,
          cover_type, absence_reason, notes } = req.body;
  if (!activity_id || !cover_date || !absent_teacher_id) {
    return res.status(400).json({ error: 'activity_id, cover_date, absent_teacher_id required' });
  }

  try {
    let coverName = null;
    if (cover_teacher_id) {
      const { rows } = await db().query(
        `SELECT first_name || ' ' || last_name AS name FROM ${s}.staff WHERE id=$1`, [cover_teacher_id]);
      coverName = rows[0]?.name || null;
    }

    const { rows } = await db().query(`
      INSERT INTO ${s}.timetable_cover
        (activity_id, cover_date, absent_teacher_id, cover_teacher_id, cover_teacher_name,
         cover_type, absence_reason, notes, set_by_id, set_by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT DO NOTHING
      RETURNING *
    `, [
      activity_id, cover_date, absent_teacher_id,
      cover_teacher_id || null, coverName,
      cover_type || 'cover', absence_reason || null, notes || null,
      req.user.id, req.user.name || null
    ]);

    // Notify cover teacher via Telegram if configured
    if (cover_teacher_id && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      const actRes = await db().query(
        `SELECT a.subject_name, a.day_of_week, p.label AS period_label,
                cls.name AS class_name
         FROM ${s}.timetable_activities a
         LEFT JOIN ${s}.timetable_periods p ON p.id = a.period_id
         LEFT JOIN ${s}.classes cls         ON cls.id = a.class_id
         WHERE a.id = $1`, [activity_id]);
      const act = actRes.rows[0];
      if (act) {
        const msg = `📋 Cover assigned: ${coverName} to cover ${act.subject_name || 'lesson'} `
          + `(${act.class_name || ''}) on ${cover_date} ${act.period_label || ''}`;
        const https = require('https');
        const body  = JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: msg });
        const hReq  = https.request({
          hostname: 'api.telegram.org',
          path: `/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        });
        hReq.write(body); hReq.end();
      }

      await db().query(`UPDATE ${s}.timetable_cover SET notified=true WHERE id=$1`, [rows[0]?.id]);
    }

    res.json(rows[0] || { ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Cover: list ───────────────────────────────────────────────────────────────

router.get('/cover', authenticate, async (req, res) => {
  const s = schema();
  const { date_from, date_to, teacher_id } = req.query;
  const where = ['1=1'];
  const vals  = [];
  if (date_from) { vals.push(date_from); where.push(`c.cover_date >= $${vals.length}`); }
  if (date_to)   { vals.push(date_to);   where.push(`c.cover_date <= $${vals.length}`); }
  if (teacher_id){ vals.push(parseInt(teacher_id)); where.push(`(c.absent_teacher_id=$${vals.length} OR c.cover_teacher_id=$${vals.length})`); }

  try {
    const { rows } = await db().query(`
      SELECT c.*,
             a.subject_name, a.day_of_week, a.week_pattern,
             p.label AS period_label, p.start_time, p.end_time,
             cls.name AS class_name,
             st.first_name||' '||st.last_name AS absent_teacher_name
      FROM ${s}.timetable_cover c
      LEFT JOIN ${s}.timetable_activities a ON a.id = c.activity_id
      LEFT JOIN ${s}.timetable_periods p    ON p.id = a.period_id
      LEFT JOIN ${s}.classes cls            ON cls.id = a.class_id
      LEFT JOIN ${s}.staff st               ON st.id = c.absent_teacher_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.cover_date DESC, p.period_num
    `, vals);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Swaps: list ───────────────────────────────────────────────────────────────

router.get('/swaps', authenticate, async (req, res) => {
  const s = schema();
  const { status } = req.query;
  const vals  = [];
  const where = ['1=1'];
  if (status) { vals.push(status); where.push(`sw.status=$${vals.length}`); }

  try {
    const { rows } = await db().query(`
      SELECT sw.*,
             a.subject_name  AS subject_a,  a.day_of_week AS day_a,
             p.label         AS period_a_label,
             b.subject_name  AS subject_b,  b.day_of_week AS day_b,
             pb.label        AS period_b_label
      FROM ${s}.timetable_swaps sw
      LEFT JOIN ${s}.timetable_activities a  ON a.id = sw.activity_a_id
      LEFT JOIN ${s}.timetable_periods    p  ON p.id = a.period_id
      LEFT JOIN ${s}.timetable_activities b  ON b.id = sw.activity_b_id
      LEFT JOIN ${s}.timetable_periods    pb ON pb.id = b.period_id
      WHERE ${where.join(' AND ')}
      ORDER BY sw.created_at DESC
    `, vals);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Swaps: request (any teacher) ──────────────────────────────────────────────

router.post('/swaps', authenticate, async (req, res) => {
  const s = schema();
  const { activity_a_id, activity_b_id, swap_date, reason } = req.body;
  if (!activity_a_id || !activity_b_id || !swap_date) {
    return res.status(400).json({ error: 'activity_a_id, activity_b_id, swap_date required' });
  }

  try {
    const [aRes, bRes] = await Promise.all([
      db().query(`SELECT a.*, st.first_name||' '||st.last_name AS teacher_name
                  FROM ${s}.timetable_activities a
                  LEFT JOIN ${s}.staff st ON st.id=a.teacher_id WHERE a.id=$1`, [activity_a_id]),
      db().query(`SELECT a.*, st.first_name||' '||st.last_name AS teacher_name
                  FROM ${s}.timetable_activities a
                  LEFT JOIN ${s}.staff st ON st.id=a.teacher_id WHERE a.id=$1`, [activity_b_id]),
    ]);

    const actA = aRes.rows[0], actB = bRes.rows[0];
    if (!actA || !actB) return res.status(404).json({ error: 'Activity not found' });

    // Requester must be one of the teachers (managers/headteachers can create any swap)
    const adminRoles2 = ['manager','deputy_manager','headteacher','deputy_headteacher','admin'];
    if (!adminRoles2.includes(req.user.role)) {
      if (req.user.id !== actA.teacher_id && req.user.id !== actB.teacher_id) {
        return res.status(403).json({ error: 'You can only request swaps for your own lessons' });
      }
    }

    const { rows } = await db().query(`
      INSERT INTO ${s}.timetable_swaps
        (activity_a_id, activity_b_id, swap_date, teacher_a_id, teacher_b_id,
         teacher_a_name, teacher_b_name, reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [
      activity_a_id, activity_b_id, swap_date,
      actA.teacher_id, actB.teacher_id,
      actA.teacher_name, actB.teacher_name,
      reason || null
    ]);

    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Swaps: approve / reject (manager only) ────────────────────────────────────

router.put('/swaps/:id/approve', requireRole('manager', 'deputy_manager', 'headteacher', 'deputy_headteacher'), async (req, res) => {
  const s = schema();
  try {
    const { rows } = await db().query(`
      UPDATE ${s}.timetable_swaps
      SET status='approved', approved_by_id=$1, approved_by_name=$2, approved_at=NOW()
      WHERE id=$3 AND status='pending' RETURNING *
    `, [req.user.id, req.user.name || null, parseInt(req.params.id)]);

    if (!rows[0]) return res.status(404).json({ error: 'Swap not found or already decided' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/swaps/:id/reject', requireRole('manager', 'deputy_manager', 'headteacher', 'deputy_headteacher'), async (req, res) => {
  const s = schema();
  try {
    const { rows } = await db().query(`
      UPDATE ${s}.timetable_swaps
      SET status='rejected', approved_by_id=$1, approved_by_name=$2, approved_at=NOW()
      WHERE id=$3 AND status='pending' RETURNING *
    `, [req.user.id, req.user.name || null, parseInt(req.params.id)]);

    if (!rows[0]) return res.status(404).json({ error: 'Swap not found or already decided' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Import batches: delete a batch ───────────────────────────────────────────

router.delete('/import/batch/:batchId', requireRole('manager', 'deputy_manager', 'headteacher', 'deputy_headteacher'), async (req, res) => {
  const s = schema();
  try {
    const { rowCount } = await db().query(
      `DELETE FROM ${s}.timetable_activities WHERE import_batch=$1::uuid`, [req.params.batchId]);
    res.json({ deleted: rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
