'use strict';
// classroom-daily-sync.js
// Pulls courses, coursework, and submissions from Google Classroom into
// the classroom_cache table for the given schema.
//
// Triggered via POST /api/classroom/sync (called from n8n daily schedule or
// manually from the admin settings page).
//
// Standalone usage:
//   CLASSROOM_SCHEMAS=demo_secondary node src/jobs/classroom-daily-sync.js
//
// n8n schedule (Mon–Fri 05:00):
//   HTTP Request node → POST http://wren-secondary:3000/api/classroom/sync
//   Headers: Authorization: Bearer <admin-jwt>

require('dotenv').config({ path: require('path').join(__dirname, '../../editions/eyfs/.env'), override: false });

const { Pool } = require('pg');
const gc = require('../lib/google-classroom-client');

async function syncSchema(pgConfig, schema) {
  const pool = new Pool({ ...pgConfig, options: `-c search_path=${schema},public` });
  const log = (...args) => console.log(`[classroom-sync][${schema}]`, ...args);

  try {
    const { rows } = await pool.query('SELECT * FROM classroom_settings WHERE school_id=1');
    const settings = rows[0];

    if (!settings || !settings.enabled) {
      log('Integration disabled or not configured — skipping');
      await pool.end().catch(() => {});
      return { skipped: true };
    }

    const adminEmail = settings.admin_email;
    if (!adminEmail) {
      log('No admin_email set — skipping');
      await pool.end().catch(() => {});
      return { skipped: true };
    }

    log(`Starting sync as ${adminEmail}`);

    // Build email → wren_child_id lookup
    const { rows: childRows } = await pool.query(
      "SELECT id, email FROM children WHERE email IS NOT NULL AND email != ''"
    );
    const emailToChildId = {};
    childRows.forEach(c => { emailToChildId[c.email.toLowerCase()] = c.id; });

    let coursesSynced = 0, submissionsSynced = 0;
    const warnings = [];

    // ── Courses ─────────────────────────────────────────────────────────────
    const courses = await gc.listCourses(adminEmail);
    log(`Found ${courses.length} active courses`);

    for (const course of courses) {
      await pool.query(
        `INSERT INTO classroom_courses (school_id, course_id, name, section, course_state, updated_at)
         VALUES (1,$1,$2,$3,$4,now())
         ON CONFLICT (school_id, course_id) DO UPDATE SET
           name=$2, section=$3, course_state=$4, updated_at=now()`,
        [course.id, course.name || '', course.section || null, course.courseState || 'ACTIVE']
      );
      coursesSynced++;
    }

    // ── Coursework + submissions ─────────────────────────────────────────────
    for (const course of courses) {
      const [coursework, students] = await Promise.all([
        gc.listCoursework(adminEmail, course.id).catch(e => { log(`coursework error ${course.id}:`, e.message); return []; }),
        gc.listStudents(adminEmail, course.id).catch(e => { log(`students error ${course.id}:`, e.message); return []; }),
      ]);

      // userId → email map
      const userEmailMap = {};
      for (const s of students) {
        const email = s.profile?.emailAddress;
        if (email && s.userId) userEmailMap[s.userId] = email.toLowerCase();
      }

      for (const cw of coursework) {
        // Parse Google's dueDate object → ISO date string
        let dueDate = null;
        if (cw.dueDate) {
          const { year, month, day } = cw.dueDate;
          dueDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }

        const submissions = await gc.listSubmissions(adminEmail, course.id, cw.id)
          .catch(e => { log(`submissions error ${cw.id}:`, e.message); return []; });

        for (const sub of submissions) {
          const email = userEmailMap[sub.userId] || null;
          const wrenChildId = email ? (emailToChildId[email] || null) : null;

          if (email && !wrenChildId && !warnings.includes(email)) {
            warnings.push(email);
          }

          await pool.query(
            `INSERT INTO classroom_cache
               (school_id, course_id, course_name, coursework_id, coursework_title, coursework_type,
                due_date, max_points, student_email, student_id, wren_child_id,
                submission_state, assigned_grade, draft_grade, submission_id, last_synced_at)
             VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
             ON CONFLICT (school_id, coursework_id, student_id) DO UPDATE SET
               course_name=$2, coursework_title=$4, coursework_type=$5,
               due_date=$6, max_points=$7, student_email=$8, wren_child_id=$10,
               submission_state=$11, assigned_grade=$12, draft_grade=$13,
               submission_id=$14, last_synced_at=now()`,
            [
              course.id, course.name || '',
              cw.id, cw.title || '', cw.workType || null,
              dueDate, cw.maxPoints || null,
              email, sub.userId, wrenChildId,
              sub.state || null,
              sub.assignedGrade != null ? sub.assignedGrade : null,
              sub.draftGrade   != null ? sub.draftGrade   : null,
              sub.id,
            ]
          );
          submissionsSynced++;
        }
      }
    }

    // ── Record success ───────────────────────────────────────────────────────
    await pool.query(
      `UPDATE classroom_settings SET
         last_sync_at=now(), last_sync_ok=true, last_sync_error=null,
         last_sync_courses_cnt=$1, last_sync_students_cnt=$2
       WHERE school_id=1`,
      [coursesSynced, submissionsSynced]
    );

    if (warnings.length) {
      log(`${warnings.length} unmatched Classroom emails (first 5):`, warnings.slice(0, 5).join(', '));
    }

    log(`Done — ${coursesSynced} courses, ${submissionsSynced} submissions`);
    return { courses: coursesSynced, submissions: submissionsSynced, warnings: warnings.length };

  } catch (err) {
    log('Sync failed:', err.message);
    try {
      await pool.query(
        `UPDATE classroom_settings SET last_sync_at=now(), last_sync_ok=false, last_sync_error=$1 WHERE school_id=1`,
        [err.message.slice(0, 500)]
      );
    } catch (_) {}
    return { error: err.message };

  } finally {
    await pool.end().catch(() => {});
  }
}

// ── Standalone execution ─────────────────────────────────────────────────────
if (require.main === module) {
  const schemas = (process.env.CLASSROOM_SCHEMAS || process.env.PG_SCHEMA || 'demo_secondary')
    .split(',').map(s => s.trim()).filter(Boolean);

  const pgConfig = {
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5434'),
    database: process.env.PG_DB || 'wren',
    user: process.env.PG_USER || 'wren',
    password: process.env.PG_PASSWORD,
  };

  Promise.all(schemas.map(s => syncSchema(pgConfig, s)))
    .then(results => { console.log('All done:', JSON.stringify(results)); process.exit(0); })
    .catch(err => { console.error('Fatal:', err.message); process.exit(1); });
}

module.exports = { syncSchema };
