'use strict';
const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const AdmZip       = require('adm-zip');

router.use(authenticate);

// ── Helpers ───────────────────────────────────────────────────────────────────

function rag(score, max) {
  const pct = score / max;
  if (pct >= 0.9) return 'green';
  if (pct >= 0.5) return 'amber';
  return 'red';
}

function daysDiff(dateA, dateB = new Date()) {
  return Math.floor((new Date(dateA) - new Date(dateB)) / 86400000);
}

async function logAccess(db, inspectionId, staffId, action, entityType, entityId, ip) {
  try {
    await db.query(
      `INSERT INTO inspection_access_log(inspection_id,staff_id,action,entity_type,entity_id,ip)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [inspectionId || null, staffId || null, action, entityType || null, entityId || null, ip || null]
    );
  } catch {}
}

// ── Readiness score computation ───────────────────────────────────────────────
// Returns { score: 0-100, categories: [{id,label,rag,score,max,issues:[],link}] }

async function computeReadiness(db, schema) {
  const s = schema || 'ladn';
  const cats = [];

  // 1. DSL / Safeguarding lead training (15pts)
  {
    const { rows: mgrs } = await db.query(
      `SELECT s.id, s.first_name||' '||s.last_name AS name,
              max(st.expiry_date) AS latest_expiry
       FROM ${s}.staff s
       LEFT JOIN ${s}.safeguarding_training st
         ON st.staff_id = s.id
        AND (st.training_type ILIKE '%DSL%' OR st.training_type ILIKE '%safeguard%' OR st.training_type ILIKE '%designated%')
       WHERE s.is_active = true AND s.role IN ('manager','room_leader')
       GROUP BY s.id, name`
    );
    const issues = [];
    let pts = 15;
    for (const m of mgrs) {
      if (!m.latest_expiry) {
        issues.push(`${m.name} has no DSL/safeguarding training on record`);
        pts = 0;
      } else if (daysDiff(m.latest_expiry) < 0) {
        issues.push(`${m.name} DSL training expired ${Math.abs(daysDiff(m.latest_expiry))} days ago`);
        pts = Math.min(pts, 0);
      } else if (daysDiff(m.latest_expiry) < 60) {
        issues.push(`${m.name} DSL training expires in ${daysDiff(m.latest_expiry)} days`);
        pts = Math.min(pts, 7);
      }
    }
    cats.push({ id: 'dsl-training', label: 'DSL Safeguarding Training', rag: issues.length === 0 ? 'green' : pts === 0 ? 'red' : 'amber', score: pts, max: 15, issues, link: '/admin/staff/training' });
  }

  // 2. All-staff mandatory training (15pts)
  {
    const { rows } = await db.query(
      `SELECT s.first_name||' '||s.last_name AS name, c.course_name, c.expiry_date
       FROM ${s}.staff s
       JOIN ${s}.cpd_records c ON c.staff_id = s.id
       WHERE s.is_active = true AND c.is_mandatory = true
         AND c.expiry_date IS NOT NULL AND c.expiry_date < CURRENT_DATE + 30`
    );
    const expiredNow  = rows.filter(r => daysDiff(r.expiry_date) < 0);
    const expiringSoon = rows.filter(r => daysDiff(r.expiry_date) >= 0 && daysDiff(r.expiry_date) < 30);
    const issues = [
      ...expiredNow.map(r => `${r.name}: ${r.course_name} expired`),
      ...expiringSoon.map(r => `${r.name}: ${r.course_name} expires in ${daysDiff(r.expiry_date)} days`),
    ];
    const pts = expiredNow.length > 0 ? 0 : expiringSoon.length > 0 ? 8 : 15;
    cats.push({ id: 'mandatory-training', label: 'Mandatory Training Currency', rag: pts === 15 ? 'green' : pts === 8 ? 'amber' : 'red', score: pts, max: 15, issues, link: '/admin/staff/training' });
  }

  // 3. DBS checks (15pts)
  {
    const { rows } = await db.query(
      `SELECT first_name||' '||last_name AS name, dbs_expiry
       FROM ${s}.staff WHERE is_active = true AND (dbs_expiry IS NULL OR dbs_expiry < CURRENT_DATE + 90)`
    );
    const noRecord   = rows.filter(r => !r.dbs_expiry);
    const expired    = rows.filter(r => r.dbs_expiry && daysDiff(r.dbs_expiry) < 0);
    const expireSoon = rows.filter(r => r.dbs_expiry && daysDiff(r.dbs_expiry) >= 0);
    const issues = [
      ...noRecord.map(r => `${r.name}: no DBS expiry recorded`),
      ...expired.map(r => `${r.name}: DBS expired ${Math.abs(daysDiff(r.dbs_expiry))} days ago`),
      ...expireSoon.map(r => `${r.name}: DBS expires in ${daysDiff(r.dbs_expiry)} days`),
    ];
    const pts = expired.length > 0 || noRecord.length > 0 ? 0 : expireSoon.length > 0 ? 8 : 15;
    cats.push({ id: 'dbs-checks', label: 'DBS Checks', rag: pts === 15 ? 'green' : pts === 8 ? 'amber' : 'red', score: pts, max: 15, issues, link: '/admin/staff/documents' });
  }

  // 4. Risk assessments (10pts)
  {
    const { rows } = await db.query(
      `SELECT title, review_date FROM ${s}.risk_assessments
       WHERE status != 'archived' AND review_date IS NOT NULL AND review_date < CURRENT_DATE`
    );
    const pts = rows.length === 0 ? 10 : rows.length <= 2 ? 5 : 0;
    const issues = rows.map(r => `${r.title}: review overdue since ${new Date(r.review_date).toLocaleDateString('en-GB')}`);
    cats.push({ id: 'risk-assessments', label: 'Risk Assessment Reviews', rag: pts === 10 ? 'green' : pts === 5 ? 'amber' : 'red', score: pts, max: 10, issues, link: '/admin/operations/health-safety' });
  }

  // 5. Fire safety (10pts)
  {
    const { rows } = await db.query(
      `SELECT MAX(drill_date) AS last_drill FROM ${s}.fire_drills`
    );
    const lastDrill = rows[0]?.last_drill;
    const daysAgo = lastDrill ? -daysDiff(lastDrill) : 9999;
    const issues = [];
    let pts = 10;
    if (!lastDrill) {
      issues.push('No fire drill on record');
      pts = 0;
    } else if (daysAgo > 180) {
      issues.push(`Last fire drill was ${daysAgo} days ago (over 6 months)`);
      pts = 0;
    } else if (daysAgo > 90) {
      issues.push(`Last fire drill was ${daysAgo} days ago — consider scheduling another`);
      pts = 5;
    }
    cats.push({ id: 'fire-safety', label: 'Fire Safety (Drills)', rag: pts === 10 ? 'green' : pts === 5 ? 'amber' : 'red', score: pts, max: 10, issues, link: '/admin/operations/health-safety' });
  }

  // 6. Open safeguarding concerns (10pts)
  {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS total,
              COUNT(CASE WHEN escalation_level IN ('lado','mash','police') THEN 1 END) AS escalated,
              COUNT(CASE WHEN dsl_signoff_at IS NULL THEN 1 END) AS unsigned
       FROM ${s}.safeguarding_concerns
       WHERE status NOT IN ('closed','resolved')`
    );
    const r = rows[0];
    const total = parseInt(r.total, 10);
    const escalated = parseInt(r.escalated, 10);
    const unsigned = parseInt(r.unsigned, 10);
    const issues = [];
    let pts = 10;
    if (escalated > 0) { issues.push(`${escalated} concern(s) at LADO/MASH/police escalation level`); pts = 0; }
    if (unsigned > 0)  { issues.push(`${unsigned} concern(s) awaiting DSL sign-off`); pts = Math.min(pts, 5); }
    if (total > 0 && issues.length === 0) { issues.push(`${total} open concern(s) — all signed off`); pts = 8; }
    cats.push({ id: 'safeguarding-concerns', label: 'Safeguarding Concerns Backlog', rag: pts === 10 ? 'green' : pts >= 8 ? 'amber' : 'red', score: pts, max: 10, issues, link: '/admin/safeguarding/concerns' });
  }

  // 7. Compliance events (10pts)
  {
    const { rows } = await db.query(
      `SELECT title, next_due FROM ${s}.compliance_events
       WHERE is_active = true AND next_due < CURRENT_DATE`
    );
    const pts = rows.length === 0 ? 10 : rows.length <= 2 ? 5 : 0;
    const issues = rows.map(r => `${r.title}: overdue since ${new Date(r.next_due).toLocaleDateString('en-GB')}`);
    cats.push({ id: 'compliance-events', label: 'Compliance Events', rag: pts === 10 ? 'green' : pts === 5 ? 'amber' : 'red', score: pts, max: 10, issues, link: '/admin/operations/compliance' });
  }

  // 8. First aid coverage (10pts)
  {
    const { rows } = await db.query(
      `SELECT s.first_name||' '||s.last_name AS name, c.expiry_date
       FROM ${s}.staff s
       JOIN ${s}.cpd_records c ON c.staff_id = s.id
       WHERE s.is_active = true AND c.is_mandatory = true
         AND (c.course_name ILIKE '%first aid%' OR c.course_name ILIKE '%paediatric%')
         AND c.expiry_date >= CURRENT_DATE`
    );
    const issues = [];
    let pts = 10;
    if (rows.length === 0) {
      issues.push('No current paediatric/first aid certificates on record');
      pts = 0;
    } else if (rows.length < 2) {
      issues.push('Only one first-aider — recommend at least 2 current');
      pts = 5;
    }
    cats.push({ id: 'first-aid', label: 'First Aid Coverage', rag: pts === 10 ? 'green' : pts === 5 ? 'amber' : 'red', score: pts, max: 10, issues, link: '/admin/staff/training' });
  }

  // 9. Single Central Record / policies (5pts — simple flag)
  {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM ${s}.staff WHERE is_active = true AND dbs_number IS NULL`
    );
    const missing = parseInt(rows[0].cnt, 10);
    const pts = missing === 0 ? 5 : 0;
    const issues = missing > 0 ? [`${missing} active staff member(s) have no DBS number recorded (SCR gap)`] : [];
    cats.push({ id: 'scr', label: 'Single Central Record', rag: pts === 5 ? 'green' : 'red', score: pts, max: 5, issues, link: '/admin/staff/documents' });
  }

  const total = cats.reduce((s, c) => s + c.score, 0);
  const maxTotal = cats.reduce((s, c) => s + c.max, 0);
  return { score: total, max: maxTotal, pct: Math.round((total / maxTotal) * 100), categories: cats };
}

// ── Generate action items for an inspection ───────────────────────────────────

async function generateActionItems(db, inspectionId, schema) {
  const readiness = await computeReadiness(db, schema);
  await db.query('DELETE FROM inspection_action_items WHERE inspection_id = $1', [inspectionId]);
  for (const cat of readiness.categories) {
    if (cat.rag === 'green') {
      await db.query(
        `INSERT INTO inspection_action_items(inspection_id,category,description,rag_status,evidence_link)
         VALUES($1,$2,$3,$4,$5)`,
        [inspectionId, cat.id, cat.label + ': compliant ✓', 'green', cat.link]
      );
    } else {
      for (const issue of cat.issues) {
        await db.query(
          `INSERT INTO inspection_action_items(inspection_id,category,description,rag_status,evidence_link)
           VALUES($1,$2,$3,$4,$5)`,
          [inspectionId, cat.id, issue, cat.rag, cat.link]
        );
      }
      if (cat.issues.length === 0) {
        await db.query(
          `INSERT INTO inspection_action_items(inspection_id,category,description,rag_status,evidence_link)
           VALUES($1,$2,$3,$4,$5)`,
          [inspectionId, cat.id, cat.label + ': review required', cat.rag, cat.link]
        );
      }
    }
  }
  return readiness;
}

// ── EIF / EYFS gap analysis ───────────────────────────────────────────────────

async function computeGapAnalysis(db, schema, framework) {
  const s = schema || 'ladn';

  const isEYFS = !framework || framework.includes('eyfs');

  // Gather evidence counts
  const { rows: obsRows } = await db.query(
    `SELECT COUNT(*) AS cnt FROM ${s}.observations WHERE created_at >= NOW() - INTERVAL '6 weeks'`
  ).catch(() => ({ rows: [{ cnt: 0 }] }));
  const recentObs = parseInt(obsRows[0].cnt, 10);

  const { rows: senRows } = await db.query(
    `SELECT COUNT(*) AS cnt FROM ${s}.sen_register WHERE status = 'active'`
  ).catch(() => ({ rows: [{ cnt: 0 }] }));
  const activeSEN = parseInt(senRows[0].cnt, 10);

  const { rows: cpRows } = await db.query(
    `SELECT COUNT(*) AS cnt FROM ${s}.curriculum_plans WHERE created_at >= NOW() - INTERVAL '6 weeks'`
  ).catch(() => ({ rows: [{ cnt: 0 }] }));
  const recentPlanning = parseInt(cpRows[0].cnt, 10);

  const themes = isEYFS ? [
    {
      id: 'quality-education',
      label: 'Quality of Education',
      strengths: [
        recentObs > 20 ? `${recentObs} observations recorded in the last 6 weeks` : null,
        recentPlanning > 0 ? `${recentPlanning} curriculum plans in last 6 weeks` : null,
        'Individual next-steps documented in learning journeys',
      ].filter(Boolean),
      weaknesses: [
        recentObs < 10 ? 'Fewer than 10 observations in last 6 weeks — evidence thin' : null,
        recentPlanning === 0 ? 'No curriculum plans found in last 6 weeks' : null,
      ].filter(Boolean),
      narrative: 'Our curriculum is rooted in the EYFS prime and specific areas, with regular observations informing individual next steps. Planning is responsive to children\'s interests and development stage.',
    },
    {
      id: 'behaviour-attitudes',
      label: 'Behaviour & Attitudes',
      strengths: [
        'Positive behaviour policy in place',
        'Incidents logged and followed up promptly',
        'Staff trained in behaviour support approaches',
      ],
      weaknesses: [],
      narrative: 'We promote positive behaviour through consistent routines, co-regulation, and a nurturing environment. Incidents are recorded and reviewed with appropriate follow-up.',
    },
    {
      id: 'personal-development',
      label: 'Personal Development',
      strengths: [
        'Partnership-with-parents approach embedded',
        'Healthy eating, physical activity and wellbeing built into daily routine',
        activeSEN > 0 ? `${activeSEN} children on SEN support with APDR cycles in place` : 'SEN register current',
      ],
      weaknesses: [
        activeSEN > 3 ? 'Multiple children on SEN support — ensure review dates are current' : null,
      ].filter(Boolean),
      narrative: 'Children\'s personal, social and emotional development is central to our practice. We work closely with families, external agencies and the local authority to support all children.',
    },
    {
      id: 'leadership',
      label: 'Leadership & Management',
      strengths: [
        'Action plan in place with measurable targets',
        'Regular staff supervisions and CPD programme',
        'Safeguarding policy reviewed and ratified',
      ],
      weaknesses: [],
      narrative: 'Leadership is ambitious and reflective. The improvement plan is evidence-driven, and staff development is prioritised. Safeguarding is the responsibility of all staff, led by the trained DSL.',
    },
  ] : [
    {
      id: 'quality-education',
      label: 'Quality of Education',
      strengths: ['Curriculum planned sequentially across year groups', 'Assessment data tracked termly'],
      weaknesses: [],
      narrative: 'The curriculum is designed to give all pupils the knowledge and skills to succeed. Assessment informs intervention and catch-up.',
    },
    {
      id: 'behaviour-attitudes',
      label: 'Behaviour & Attitudes',
      strengths: ['Behaviour policy clear and consistently applied', 'Exclusion data reviewed regularly'],
      weaknesses: [],
      narrative: 'Behaviour expectations are high and consistently upheld. Pupils feel safe and respected.',
    },
    {
      id: 'personal-development',
      label: 'Personal Development',
      strengths: ['SMSC embedded across curriculum', 'Attendance monitored with early intervention'],
      weaknesses: [],
      narrative: 'Pupils\' wider development — including careers, citizenship and wellbeing — is actively promoted.',
    },
    {
      id: 'leadership',
      label: 'Leadership & Management',
      strengths: ['SIP evidence-based and ambitious', 'Governance robust and challenging'],
      weaknesses: [],
      narrative: 'Leaders are clear about the school\'s strengths and areas for development, and have the capacity to drive improvement.',
    },
  ];

  return { framework: framework || 'ofsted-eyfs-2025', themes };
}

// ── Build briefing data per staff role ────────────────────────────────────────

async function buildBriefingData(db, schema, staffId, inspectionId) {
  const s = schema || 'ladn';
  const { rows: [staff] } = await db.query(
    `SELECT id, first_name, last_name, role FROM ${s}.staff WHERE id = $1`, [staffId]
  );
  if (!staff) return null;

  const role = staff.role;
  const name = `${staff.first_name} ${staff.last_name}`;

  // Common: today's planned activities
  const { rows: activities } = await db.query(
    `SELECT title, room_id FROM ${s}.curriculum_activities WHERE activity_date = CURRENT_DATE LIMIT 5`
  ).catch(() => ({ rows: [] }));

  const briefing = { staffId, name, role, generatedAt: new Date().toISOString(), sections: [] };

  if (['manager', 'room_leader'].includes(role)) {
    // DSL / leadership briefing
    const { rows: concerns } = await db.query(
      `SELECT id, category, status, severity, escalation_level, created_at
       FROM ${s}.safeguarding_concerns WHERE status NOT IN ('closed','resolved') ORDER BY created_at DESC LIMIT 20`
    ).catch(() => ({ rows: [] }));
    const { rows: recentReferrals } = await db.query(
      `SELECT id, category, referral_agency, referral_date FROM ${s}.safeguarding_concerns
       WHERE is_referral = true AND referral_date >= CURRENT_DATE - 90 ORDER BY referral_date DESC LIMIT 10`
    ).catch(() => ({ rows: [] }));
    const readiness = await computeReadiness(db, s);

    briefing.sections = [
      { title: 'Your Role During the Inspection', body: 'As manager/DSL, you are the main point of contact for the inspector. Remain calm, factual, and refer to the evidence in Wren.' },
      { title: 'Whole-Setting Readiness Score', body: `Current readiness: ${readiness.pct}%. Key gaps: ${readiness.categories.filter(c => c.rag !== 'green').map(c => c.label).join(', ') || 'None identified'}.` },
      { title: 'Open Safeguarding Concerns', items: concerns.map(c => `#${c.id} — ${c.category} (${c.status}${c.escalation_level ? ', ' + c.escalation_level : ''})`) },
      { title: 'Recent Referrals (last 90 days)', items: recentReferrals.map(r => `${r.referral_agency} — ${r.category} — ${new Date(r.referral_date).toLocaleDateString('en-GB')}`) },
      { title: 'What Inspectors Are Likely to Ask', items: ['How do you ensure all staff training is current?', 'Walk me through your last safeguarding referral.', 'How do you monitor ratios?', 'What is your self-evaluation process?', 'How do you support children with SEND?'] },
      { title: "Today's Activities", items: activities.map(a => a.title) },
    ];
  } else {
    // Practitioner briefing
    const { rows: myObs } = await db.query(
      `SELECT c.first_name||' '||c.last_name AS child_name, o.obs_type, o.created_at
       FROM ${s}.observations o JOIN ${s}.children c ON c.id = o.child_id
       WHERE o.created_by = $1 AND o.created_at >= CURRENT_DATE - 30 ORDER BY o.created_at DESC LIMIT 5`,
      [staffId]
    ).catch(() => ({ rows: [] }));

    briefing.sections = [
      { title: 'Your Role During the Inspection', body: 'Be natural and continue with your normal day. If an inspector speaks to you, answer honestly. You don\'t need to have every answer — "I\'ll check with the manager" is always fine.' },
      { title: 'What Inspectors Might Ask You', items: ['Tell me about a recent observation you made.', 'How do you decide on activities for the children?', 'How do you support a child\'s next steps?', 'What do you do if you have a safeguarding concern?', 'How do you involve parents in their child\'s learning?'] },
      { title: 'Where to Find Your Evidence', body: 'Your observations are in Wren → EY Learning → Observations. Learning journeys are per-child. Your planning is in Wren → Curriculum.' },
      { title: 'Your Recent Observations', items: myObs.map(o => `${o.child_name} — ${o.obs_type} (${new Date(o.created_at).toLocaleDateString('en-GB')})`) },
      { title: "Today's Planned Activities", items: activities.map(a => a.title) },
      { title: 'A Few Things You\'ve Done Well', body: `You have ${myObs.length} observations in the last 30 days. Keep going — that evidence matters.` },
    ];
  }

  return briefing;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/inspection/readiness — real-time score (no active inspection needed)
router.get('/readiness', async (req, res) => {
  try {
    const db = getPool();
    const schema = req.user?.schema || 'ladn';
    const result = await computeReadiness(db, schema);
    await logAccess(db, null, req.user?.id, 'readiness_check', null, null, req.ip);
    res.json(result);
  } catch (err) {
    console.error('readiness error', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inspection/active — currently active inspection (if any)
router.get('/active', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM inspection_modes WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`
    );
    res.json({ inspection: rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inspection — list inspections
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT im.*, s.first_name||' '||s.last_name AS created_by_name
       FROM inspection_modes im
       LEFT JOIN staff s ON s.id = im.created_by
       ORDER BY im.created_at DESC LIMIT 50`
    );
    res.json({ inspections: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/inspection — create new inspection
router.post('/', async (req, res) => {
  try {
    const db = getPool();
    const { type, notified_at, expected_arrival, inspector_name, inspector_org, framework_used } = req.body;
    if (!type) return res.status(400).json({ error: 'type required' });
    const schema = req.user?.schema || 'ladn';

    // Cancel any currently active inspections first
    await db.query(
      `UPDATE inspection_modes SET status = 'cancelled' WHERE status = 'active'`
    );

    const { rows: [inspection] } = await db.query(
      `INSERT INTO inspection_modes(type,notified_at,expected_arrival,inspector_name,inspector_org,framework_used,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [type, notified_at || new Date(), expected_arrival || null, inspector_name || null, inspector_org || 'Ofsted', framework_used || 'ofsted-eyfs-2025', req.user?.id || null]
    );

    // Generate action items
    const readiness = await generateActionItems(db, inspection.id, schema);

    await logAccess(db, inspection.id, req.user?.id, 'inspection_created', 'inspection_modes', String(inspection.id), req.ip);

    // Write audit log entry
    await db.query(
      `INSERT INTO audit_log(actor_type,actor_id,actor_email,action,entity_type,entity_id,edition,ip)
       VALUES('staff',$1,$2,'inspection_started','inspection_modes',$3,$4,$5)`,
      [req.user?.id, req.user?.email, String(inspection.id), req.app.get('wren_edition') || 'admin', req.ip]
    ).catch(() => {});

    res.json({ inspection, readiness });
  } catch (err) {
    console.error('inspection create error', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inspection/:id — get inspection with action items
router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [inspection] } = await db.query(
      `SELECT im.*, s.first_name||' '||s.last_name AS created_by_name
       FROM inspection_modes im
       LEFT JOIN staff s ON s.id = im.created_by
       WHERE im.id = $1`, [req.params.id]
    );
    if (!inspection) return res.status(404).json({ error: 'Not found' });

    const { rows: actionItems } = await db.query(
      `SELECT ai.*, s.first_name||' '||s.last_name AS resolved_by_name
       FROM inspection_action_items ai
       LEFT JOIN staff s ON s.id = ai.resolved_by
       WHERE ai.inspection_id = $1 ORDER BY
         CASE rag_status WHEN 'red' THEN 0 WHEN 'amber' THEN 1 ELSE 2 END, category, id`,
      [req.params.id]
    );

    await logAccess(db, req.params.id, req.user?.id, 'inspection_viewed', 'inspection_modes', req.params.id, req.ip);

    res.json({ inspection, actionItems });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/inspection/:id — update inspection metadata
router.put('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { inspector_name, inspector_org, expected_arrival, actual_arrival, framework_used } = req.body;
    const { rows: [inspection] } = await db.query(
      `UPDATE inspection_modes
       SET inspector_name = COALESCE($2, inspector_name),
           inspector_org  = COALESCE($3, inspector_org),
           expected_arrival = COALESCE($4, expected_arrival),
           actual_arrival   = COALESCE($5, actual_arrival),
           framework_used   = COALESCE($6, framework_used)
       WHERE id = $1 RETURNING *`,
      [req.params.id, inspector_name, inspector_org, expected_arrival, actual_arrival, framework_used]
    );
    if (!inspection) return res.status(404).json({ error: 'Not found' });
    res.json({ inspection });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/inspection/:id/refresh — re-run readiness and regenerate action items
router.post('/:id/refresh', async (req, res) => {
  try {
    const db = getPool();
    const schema = req.user?.schema || 'ladn';
    const readiness = await generateActionItems(db, req.params.id, schema);
    await logAccess(db, req.params.id, req.user?.id, 'readiness_refreshed', null, null, req.ip);
    res.json({ readiness });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/inspection/:id/action-items/:itemId/resolve
router.patch('/:id/action-items/:itemId/resolve', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [item] } = await db.query(
      `UPDATE inspection_action_items
       SET resolved_at = NOW(), resolved_by = $3
       WHERE id = $1 AND inspection_id = $2 RETURNING *`,
      [req.params.itemId, req.params.id, req.user?.id || null]
    );
    if (!item) return res.status(404).json({ error: 'Not found' });
    await logAccess(db, req.params.id, req.user?.id, 'action_item_resolved', 'inspection_action_items', req.params.itemId, req.ip);
    res.json({ item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inspection/:id/gap-analysis
router.get('/:id/gap-analysis', async (req, res) => {
  try {
    const db = getPool();
    const schema = req.user?.schema || 'ladn';
    const { rows: [inspection] } = await db.query(
      'SELECT framework_used FROM inspection_modes WHERE id = $1', [req.params.id]
    );
    const result = await computeGapAnalysis(db, schema, inspection?.framework_used);
    await logAccess(db, req.params.id, req.user?.id, 'gap_analysis_viewed', null, null, req.ip);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inspection/:id/briefings — list briefings
router.get('/:id/briefings', async (req, res) => {
  try {
    const db = getPool();
    const schema = req.user?.schema || 'ladn';
    // Get all active staff
    const { rows: staffList } = await db.query(
      `SELECT s.id, s.first_name||' '||s.last_name AS name, s.role,
              b.id AS briefing_id, b.generated_at, b.acknowledged_at
       FROM ${schema}.staff s
       LEFT JOIN inspection_briefings b ON b.staff_id = s.id AND b.inspection_id = $1
       WHERE s.is_active = true ORDER BY s.role, s.first_name`,
      [req.params.id]
    );
    res.json({ staff: staffList });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inspection/:id/briefing/:staffId — generate briefing data
router.get('/:id/briefing/:staffId', async (req, res) => {
  try {
    const db = getPool();
    const schema = req.user?.schema || 'ladn';
    const data = await buildBriefingData(db, schema, req.params.staffId, req.params.id);
    if (!data) return res.status(404).json({ error: 'Staff not found' });

    // Upsert briefing record
    await db.query(
      `INSERT INTO inspection_briefings(inspection_id, staff_id, role, generated_at)
       VALUES($1, $2, $3, NOW())
       ON CONFLICT DO NOTHING`,
      [req.params.id, req.params.staffId, data.role]
    ).catch(() => {});

    await logAccess(db, req.params.id, req.user?.id, 'briefing_viewed', 'staff', req.params.staffId, req.ip);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/inspection/:id/briefing/:staffId/acknowledge
router.post('/:id/briefing/:staffId/acknowledge', async (req, res) => {
  try {
    const db = getPool();
    await db.query(
      `UPDATE inspection_briefings SET acknowledged_at = NOW()
       WHERE inspection_id = $1 AND staff_id = $2`,
      [req.params.id, req.params.staffId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/inspection/:id/close — close the inspection
router.post('/:id/close', async (req, res) => {
  try {
    const db = getPool();
    const { outcome_judgement, outcome_summary } = req.body;
    const { rows: [inspection] } = await db.query(
      `UPDATE inspection_modes
       SET status = 'complete', closed_at = NOW(), closed_by = $2,
           outcome_judgement = $3, outcome_summary = $4
       WHERE id = $1 RETURNING *`,
      [req.params.id, req.user?.id || null, outcome_judgement || null, outcome_summary || null]
    );
    if (!inspection) return res.status(404).json({ error: 'Not found' });

    await logAccess(db, req.params.id, req.user?.id, 'inspection_closed', 'inspection_modes', req.params.id, req.ip);
    await db.query(
      `INSERT INTO audit_log(actor_type,actor_id,actor_email,action,entity_type,entity_id,edition,ip)
       VALUES('staff',$1,$2,'inspection_closed','inspection_modes',$3,$4,$5)`,
      [req.user?.id, req.user?.email, String(req.params.id), req.app.get('wren_edition') || 'admin', req.ip]
    ).catch(() => {});

    res.json({ inspection });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inspection/:id/retrospective — post-inspection review data
router.get('/:id/retrospective', async (req, res) => {
  try {
    const db = getPool();
    const { rows: accessLog } = await db.query(
      `SELECT al.action, al.entity_type, al.entity_id, al.accessed_at,
              s.first_name||' '||s.last_name AS staff_name
       FROM inspection_access_log al
       LEFT JOIN staff s ON s.id = al.staff_id
       WHERE al.inspection_id = $1 ORDER BY al.accessed_at ASC`,
      [req.params.id]
    );
    const { rows: actionItems } = await db.query(
      `SELECT * FROM inspection_action_items WHERE inspection_id = $1 ORDER BY rag_status, category`,
      [req.params.id]
    );
    const { rows: [inspection] } = await db.query(
      `SELECT * FROM inspection_modes WHERE id = $1`, [req.params.id]
    );
    res.json({ inspection, accessLog, actionItems });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/inspection/:id/export — generate evidence pack ZIP
router.post('/:id/export', async (req, res) => {
  try {
    const db = getPool();
    const schema = req.user?.schema || 'ladn';
    const { password } = req.body;

    const { rows: [inspection] } = await db.query(
      `SELECT * FROM inspection_modes WHERE id = $1`, [req.params.id]
    );
    if (!inspection) return res.status(404).json({ error: 'Not found' });

    const readiness  = await computeReadiness(db, schema);
    const gapAnalysis = await computeGapAnalysis(db, schema, inspection.framework_used);

    const { rows: actionItems } = await db.query(
      `SELECT * FROM inspection_action_items WHERE inspection_id = $1 ORDER BY rag_status, category`,
      [req.params.id]
    );
    const { rows: accessLog } = await db.query(
      `SELECT al.*, s.first_name||' '||s.last_name AS staff_name
       FROM inspection_access_log al LEFT JOIN staff s ON s.id = al.staff_id
       WHERE al.inspection_id = $1 ORDER BY al.accessed_at`,
      [req.params.id]
    );
    const { rows: staffList } = await db.query(
      `SELECT id, first_name||' '||last_name AS name, role, dbs_expiry FROM ${schema}.staff WHERE is_active = true ORDER BY role, first_name`
    );
    const { rows: concerns } = await db.query(
      `SELECT id, category, status, severity, created_at FROM ${schema}.safeguarding_concerns ORDER BY created_at DESC LIMIT 50`
    ).catch(() => ({ rows: [] }));

    const zip = new AdmZip();

    // Manifest
    const manifest = {
      school: 'Your Nursery',
      generated: new Date().toISOString(),
      inspection: {
        id: inspection.id,
        type: inspection.type,
        framework: inspection.framework_used,
        inspector: inspection.inspector_name,
        notified_at: inspection.notified_at,
        expected_arrival: inspection.expected_arrival,
      },
      readiness_score: readiness.pct,
      notice: 'This pack contains controlled school data. Do not distribute outside the inspection team.',
    };
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));

    // Readiness report HTML
    const readinessHtml = `<!DOCTYPE html><html><head><title>Inspection Readiness Report</title>
<style>body{font-family:Arial,sans-serif;margin:40px;color:#333}h1{color:#1e3a5f}
.green{color:#22c55e}.amber{color:#f59e0b}.red{color:#ef4444}
table{width:100%;border-collapse:collapse}td,th{padding:8px;border:1px solid #ddd}
.footer{margin-top:40px;font-size:0.8em;color:#666;border-top:1px solid #ddd;padding-top:10px}
</style></head><body>
<h1>Inspection Readiness Report</h1>
<p><strong>Setting:</strong> Your Nursery, 123 Example Lane, W13 9LU</p>
<p><strong>Date generated:</strong> ${new Date().toLocaleString('en-GB')}</p>
<p><strong>Readiness score:</strong> <strong>${readiness.pct}%</strong> (${readiness.score}/${readiness.max})</p>
<h2>Compliance Categories</h2>
<table><tr><th>Category</th><th>Status</th><th>Score</th><th>Issues</th></tr>
${readiness.categories.map(c => `<tr>
  <td>${c.label}</td>
  <td class="${c.rag}">${c.rag.toUpperCase()}</td>
  <td>${c.score}/${c.max}</td>
  <td>${c.issues.join('<br>') || '—'}</td>
</tr>`).join('')}
</table>
<div class="footer">This pack contains controlled school data. Do not distribute outside the inspection team.</div>
</body></html>`;
    zip.addFile('01-readiness-report.html', Buffer.from(readinessHtml));

    // Gap analysis
    const gapHtml = `<!DOCTYPE html><html><head><title>EIF Gap Analysis</title>
<style>body{font-family:Arial,sans-serif;margin:40px;color:#333}h1,h2{color:#1e3a5f}
ul{padding-left:20px}.strength{color:#22c55e}.weakness{color:#ef4444}
.narrative{background:#f5f5f5;padding:12px;border-left:4px solid #1e3a5f;margin:10px 0}
.footer{margin-top:40px;font-size:0.8em;color:#666;border-top:1px solid #ddd;padding-top:10px}
</style></head><body>
<h1>Gap Analysis — ${gapAnalysis.framework}</h1>
<p><strong>Generated:</strong> ${new Date().toLocaleString('en-GB')}</p>
${gapAnalysis.themes.map(t => `<h2>${t.label}</h2>
<h3 class="strength">Strengths</h3><ul>${t.strengths.map(s => `<li>${s}</li>`).join('')}</ul>
${t.weaknesses.length ? `<h3 class="weakness">Areas to address</h3><ul>${t.weaknesses.map(w => `<li>${w}</li>`).join('')}</ul>` : ''}
<div class="narrative"><strong>Suggested narrative:</strong> ${t.narrative}</div>`).join('')}
<div class="footer">This pack contains controlled school data. Do not distribute outside the inspection team.</div>
</body></html>`;
    zip.addFile('02-gap-analysis.html', Buffer.from(gapHtml));

    // Action items
    const actionsJson = JSON.stringify({ inspection_id: inspection.id, generated: new Date().toISOString(), items: actionItems }, null, 2);
    zip.addFile('03-action-items.json', Buffer.from(actionsJson));

    // Staff list (SCR-style)
    const staffJson = JSON.stringify({ generated: new Date().toISOString(), staff: staffList }, null, 2);
    zip.addFile('04-staff-register.json', Buffer.from(staffJson));

    // Safeguarding concerns snapshot (anonymised IDs only for export)
    const concernsExport = concerns.map(c => ({ id: c.id, category: c.category, status: c.status, severity: c.severity, created: new Date(c.created_at).toLocaleDateString('en-GB') }));
    zip.addFile('05-safeguarding-concerns-snapshot.json', Buffer.from(JSON.stringify(concernsExport, null, 2)));

    // Access log
    zip.addFile('06-access-audit-log.json', Buffer.from(JSON.stringify(accessLog, null, 2)));

    await logAccess(db, req.params.id, req.user?.id, 'evidence_pack_exported', 'inspection_modes', req.params.id, req.ip);
    await db.query(
      `INSERT INTO audit_log(actor_type,actor_id,actor_email,action,entity_type,entity_id,edition,ip)
       VALUES('staff',$1,$2,'evidence_pack_exported','inspection_modes',$3,$4,$5)`,
      [req.user?.id, req.user?.email, String(req.params.id), req.app.get('wren_edition') || 'admin', req.ip]
    ).catch(() => {});

    const zipBuffer = zip.toBuffer();
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="inspection-evidence-${inspection.id}-${new Date().toISOString().slice(0,10)}.zip"`,
      'Content-Length': zipBuffer.length,
    });
    res.send(zipBuffer);
  } catch (err) {
    console.error('export error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
