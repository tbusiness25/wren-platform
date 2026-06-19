'use strict';

const express = require('express');
const router  = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

// Helper — get parent email from CF Access header (parents portal)
function parentEmail(req) {
  return (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
}

// ── Public-ish routes (behind CF Access) ────────────────────────────────────

// GET /api/study/modules — published list with optional filters
router.get('/modules', async (req, res) => {
  const db = getPool();
  const { category, age_group, format } = req.query;
  const params = ['published'];
  let where = 'WHERE status=$1';
  if (category)  { params.push(category);  where += ` AND category=$${params.length}`; }
  if (age_group) { params.push(age_group); where += ` AND age_group=$${params.length}`; }
  if (format)    { params.push(format);    where += ` AND format=$${params.length}`; }
  try {
    const { rows } = await db.query(`
      SELECT id, slug, title, category, format, age_group, summary, duration_minutes, published_at
      FROM ladn.parent_study_modules
      ${where}
      ORDER BY published_at DESC NULLS LAST, id DESC
    `, params);
    res.json(rows);
  } catch (e) {
    console.error('study modules list:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/study/modules/:slug — full module (published only, or review if admin)
router.get('/modules/:slug', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT id, slug, title, category, format, age_group, target_audience,
             summary, content_json, duration_minutes, status, published_at
      FROM ladn.parent_study_modules
      WHERE slug=$1 AND status IN ('published','review')
    `, [req.params.slug]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('study module get:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/study/attempt/start — record a started attempt
router.post('/attempt/start', async (req, res) => {
  const email = parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const { module_id, child_name } = req.body;
  if (!module_id) return res.status(400).json({ error: 'module_id required' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      INSERT INTO ladn.parent_module_attempts (parent_email, module_id, child_name, started_at)
      VALUES ($1,$2,$3,NOW())
      RETURNING id
    `, [email, module_id, child_name || null]);
    res.json({ attempt_id: rows[0].id });
  } catch (e) {
    console.error('attempt start:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/study/attempt/complete — record completion + score
router.post('/attempt/complete', async (req, res) => {
  const email = parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const { attempt_id, score, answers, time_spent_minutes } = req.body;
  if (!attempt_id) return res.status(400).json({ error: 'attempt_id required' });
  const db = getPool();
  try {
    await db.query(`
      UPDATE ladn.parent_module_attempts
      SET completed_at=NOW(), score=$1, answers=$2, time_spent_minutes=$3
      WHERE id=$4 AND parent_email=$5
    `, [score ?? null, answers ? JSON.stringify(answers) : null, time_spent_minutes ?? null, attempt_id, email]);

    // If this completion finishes the whole guide set, flag a pending £50 credit
    // (manager must approve — never auto-applied).
    let creditEarned = false;
    try {
      const childRow = await db.query('SELECT child_name FROM ladn.parent_module_attempts WHERE id=$1', [attempt_id]);
      const credit = await maybeIssueCredit(db, email, childRow.rows[0]?.child_name);
      creditEarned = !!credit;
    } catch (e) { console.error('credit check:', e.message); }

    res.json({ ok: true, credit_earned: creditEarned });
  } catch (e) {
    console.error('attempt complete:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/study/progress — this parent's completed module ids
router.get('/progress', async (req, res) => {
  const email = parentEmail(req);
  if (!email) return res.json({ completed: [] });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT DISTINCT module_id, MAX(score) as best_score
      FROM ladn.parent_module_attempts
      WHERE parent_email=$1 AND completed_at IS NOT NULL
      GROUP BY module_id
    `, [email]);
    res.json({ completed: rows });
  } catch (e) {
    console.error('study progress:', e.message);
    res.json({ completed: [] });
  }
});

// ── £50 completion credit (all guides in the reward set) ──────────────────────
const REWARD_KEY = 'core_health_dev_2026';
const CREDIT_PENCE = 5000; // £50

// Returns { setIds:[], completedIds:[], allDone:bool, credit:{...}|null }
async function computeRewardProgress(db, email) {
  const setRes = await db.query(
    `SELECT rs.module_id, m.slug, m.title, rs.position
     FROM ladn.parent_guide_reward_set rs
     JOIN ladn.parent_study_modules m ON m.id = rs.module_id
     WHERE rs.reward_key=$1
     ORDER BY rs.position, rs.module_id`, [REWARD_KEY]);
  const set = setRes.rows;
  const setIds = set.map(r => r.module_id);
  let completedIds = [];
  let credit = null;
  if (email) {
    const compRes = await db.query(
      `SELECT DISTINCT module_id FROM ladn.parent_module_attempts
       WHERE parent_email=$1 AND completed_at IS NOT NULL AND module_id = ANY($2::int[])`,
      [email, setIds]
    );
    completedIds = compRes.rows.map(r => r.module_id);
    const credRes = await db.query(
      `SELECT id, status, amount_pence, earned_at, reviewed_at
       FROM ladn.parent_account_credits
       WHERE lower(parent_email)=lower($1) AND reward_key=$2
       ORDER BY id DESC LIMIT 1`, [email, REWARD_KEY]);
    credit = credRes.rows[0] || null;
  }
  const allDone = setIds.length > 0 && setIds.every(id => completedIds.includes(id));
  return { set, setIds, completedIds, allDone, credit, amount_pence: CREDIT_PENCE };
}

// Idempotently create a pending_approval credit when all guides are complete.
// Never auto-applies money — manager must approve. Safe to call repeatedly.
async function maybeIssueCredit(db, email, childName) {
  if (!email) return null;
  const prog = await computeRewardProgress(db, email);
  if (!prog.allDone) return null;
  if (prog.credit && ['pending_approval','approved','applied'].includes(prog.credit.status)) {
    return prog.credit; // already issued
  }
  try {
    const { rows } = await db.query(`
      INSERT INTO ladn.parent_account_credits
        (parent_email, child_name, reward_key, amount_pence, reason, status, earned_at)
      VALUES ($1,$2,$3,$4,$5,'pending_approval',NOW())
      ON CONFLICT DO NOTHING
      RETURNING id, status, amount_pence, earned_at
    `, [email, childName || null, REWARD_KEY, CREDIT_PENCE,
        'Completed all parent study guides (challenging behaviour, toilet training, weaning, common illnesses, child development)']);
    return rows[0] || prog.credit;
  } catch (e) {
    // unique partial index may block a concurrent duplicate — that's fine
    console.error('maybeIssueCredit:', e.message);
    return prog.credit;
  }
}

// GET /api/study/reward-progress — parent's progress toward the £50 credit
router.get('/reward-progress', async (req, res) => {
  const email = parentEmail(req);
  const db = getPool();
  try {
    const prog = await computeRewardProgress(db, email);
    res.json({
      reward_key: REWARD_KEY,
      amount_pence: prog.amount_pence,
      total: prog.setIds.length,
      completed: prog.completedIds.length,
      all_done: prog.allDone,
      remaining: prog.set.filter(s => !prog.completedIds.includes(s.module_id))
                          .map(s => ({ slug: s.slug, title: s.title })),
      credit_status: prog.credit ? prog.credit.status : null
    });
  } catch (e) {
    console.error('reward-progress:', e.message);
    res.json({ reward_key: REWARD_KEY, amount_pence: CREDIT_PENCE, total: 0, completed: 0, all_done: false, remaining: [], credit_status: null });
  }
});

// POST /api/study/reward/claim — claim a reward after completing a module
router.post('/reward/claim', async (req, res) => {
  const email = parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const { module_id, child_name, reward_type } = req.body;
  if (!module_id || !reward_type) return res.status(400).json({ error: 'module_id and reward_type required' });

  const validTypes = ['sticker','activity_voucher','book_recommendation','certificate'];
  if (!validTypes.includes(reward_type)) return res.status(400).json({ error: 'Invalid reward_type' });

  const db = getPool();
  try {
    // Verify module was completed by this parent
    const attempt = await db.query(`
      SELECT id FROM ladn.parent_module_attempts
      WHERE parent_email=$1 AND module_id=$2 AND completed_at IS NOT NULL
      LIMIT 1
    `, [email, module_id]);
    if (!attempt.rows.length) return res.status(403).json({ error: 'Module not completed' });

    // Check not already claimed this reward type for this module
    const existing = await db.query(`
      SELECT id FROM ladn.parent_rewards
      WHERE parent_email=$1 AND module_id=$2 AND reward_type=$3
      LIMIT 1
    `, [email, module_id, reward_type]);
    if (existing.rows.length) return res.json({ reward_id: existing.rows[0].id, already_claimed: true });

    // Fetch module for reward data generation
    const mod = await db.query(
      'SELECT id, title, category, age_group FROM ladn.parent_study_modules WHERE id=$1',
      [module_id]
    );
    if (!mod.rows.length) return res.status(404).json({ error: 'Module not found' });
    const m = mod.rows[0];

    const rewardData = buildRewardData(reward_type, m, child_name);

    const { rows } = await db.query(`
      INSERT INTO ladn.parent_rewards (parent_email, child_name, module_id, reward_type, reward_data, earned_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      RETURNING id
    `, [email, child_name || null, module_id, reward_type, JSON.stringify(rewardData)]);

    res.json({ reward_id: rows[0].id, reward_data: rewardData });
  } catch (e) {
    console.error('reward claim:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/study/reward/mine — parent's reward wallet
router.get('/reward/mine', async (req, res) => {
  const email = parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT r.id, r.child_name, r.module_id, r.reward_type, r.reward_data, r.earned_at, r.claimed,
             m.title as module_title, m.category
      FROM ladn.parent_rewards r
      LEFT JOIN ladn.parent_study_modules m ON m.id = r.module_id
      WHERE r.parent_email=$1
      ORDER BY r.earned_at DESC
    `, [email]);
    res.json(rows);
  } catch (e) {
    console.error('rewards mine:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/study/reward/:id/pdf — generate reward PDF on demand
router.get('/reward/:id/pdf', async (req, res) => {
  const email = parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT r.*, m.title as module_title, m.category, m.age_group
      FROM ladn.parent_rewards r
      LEFT JOIN ladn.parent_study_modules m ON m.id = r.module_id
      WHERE r.id=$1 AND r.parent_email=$2
    `, [req.params.id, email]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const reward = rows[0];

    const pdfBuffer = await generateRewardPDF(reward);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="ladn-${reward.reward_type}-${reward.id}.pdf"`);

    // Mark as claimed
    await db.query('UPDATE ladn.parent_rewards SET claimed=true, claimed_at=NOW() WHERE id=$1', [reward.id]);

    res.end(pdfBuffer);
  } catch (e) {
    console.error('reward pdf:', e.message);
    res.status(500).json({ error: 'PDF generation failed: ' + e.message });
  }
});

// ── Admin-only routes ────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!['manager','deputy_manager','admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// GET /api/study/admin/pending — modules in review
router.get('/admin/pending', requireAdmin, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT id, slug, title, category, format, age_group, summary,
             duration_minutes, status, version, created_by, created_at, seed_document_path
      FROM ladn.parent_study_modules
      WHERE status IN ('review','draft')
      ORDER BY created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error('study admin pending:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/study/admin/all — all modules (admin view)
router.get('/admin/all', requireAdmin, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT id, slug, title, category, format, age_group, summary,
             duration_minutes, status, version, created_by, reviewed_by,
             last_reviewed_at, published_at, created_at
      FROM ladn.parent_study_modules
      ORDER BY created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/study/admin/credits?status=pending_approval — list account credits.
// Defined before /admin/:id so the numeric-module route doesn't shadow it.
router.get('/admin/credits', authenticate, requireAdmin, async (req, res) => {
  const db = getPool();
  const status = req.query.status || null;
  try {
    const params = [];
    let where = '';
    if (status) { params.push(status); where = `WHERE c.status = $1`; }
    const { rows } = await db.query(`
      SELECT c.*,
             (SELECT count(*)::int FROM ladn.parent_portal_access pa
                WHERE lower(pa.email)=lower(c.parent_email) AND pa.is_active=true) AS portal_links
      FROM ladn.parent_account_credits c
      ${where}
      ORDER BY
        CASE c.status WHEN 'pending_approval' THEN 0 WHEN 'approved' THEN 1
                      WHEN 'applied' THEN 2 ELSE 3 END,
        c.earned_at DESC
    `, params);
    res.json(rows);
  } catch (e) {
    console.error('admin credits list:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/study/admin/:id — full module for preview/edit
// Skip non-numeric ids so this doesn't shadow named sub-routes.
router.get('/admin/:id', requireAdmin, async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  const db = getPool();
  try {
    const { rows } = await db.query(
      'SELECT * FROM ladn.parent_study_modules WHERE id=$1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/study/admin/:id/approve — approve a module
router.post('/admin/:id/approve', requireAdmin, async (req, res) => {
  const db = getPool();
  const reviewer = req.body.reviewer || (req.user.first_name + ' ' + req.user.last_name).trim();
  try {
    const { rows } = await db.query(`
      UPDATE ladn.parent_study_modules
      SET status='published', reviewed_by=$1, last_reviewed_at=NOW(), published_at=NOW(), updated_at=NOW()
      WHERE id=$2
      RETURNING id, slug, status
    `, [reviewer, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('study approve:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/study/admin/:id/reject — send back to draft
router.post('/admin/:id/reject', requireAdmin, async (req, res) => {
  const db = getPool();
  const { reason } = req.body;
  try {
    const { rows } = await db.query(`
      UPDATE ladn.parent_study_modules
      SET status='draft', reviewed_by=$1, last_reviewed_at=NOW(), updated_at=NOW(),
          content_json = content_json || jsonb_build_object('_rejection_reason', $2::text)
      WHERE id=$3
      RETURNING id, slug, status
    `, [(req.user.first_name + ' ' + req.user.last_name).trim(), reason || '', req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('study reject:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/study/admin/:id/content — update content_json (Monaco editor save)
router.put('/admin/:id/content', requireAdmin, async (req, res) => {
  const db = getPool();
  const { content_json, title, summary, duration_minutes } = req.body;
  try {
    const { rows } = await db.query(`
      UPDATE ladn.parent_study_modules
      SET content_json=COALESCE($1::jsonb, content_json),
          title=COALESCE($2, title),
          summary=COALESCE($3, summary),
          duration_minutes=COALESCE($4, duration_minutes),
          updated_at=NOW()
      WHERE id=$5
      RETURNING id, slug, status
    `, [
      content_json ? JSON.stringify(content_json) : null,
      title || null, summary || null, duration_minutes || null,
      req.params.id
    ]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('study content update:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Manager: parent account credit approval (£50 completion reward) ───────────
// These endpoints gate real money, so they require an authenticated manager.
// NOTE: GET /admin/credits is defined ABOVE the GET /admin/:id route so it
// isn't shadowed by the numeric-module lookup.

// POST /api/study/admin/credits/:id/approve — manager approves the credit
router.post('/admin/credits/:id/approve', authenticate, requireAdmin, async (req, res) => {
  const db = getPool();
  const reviewer = (req.user.first_name ? (req.user.first_name + ' ' + (req.user.last_name||'')).trim() : (req.user.username || 'Manager'));
  const notes = (req.body && req.body.notes) || null;
  try {
    const { rows } = await db.query(`
      UPDATE ladn.parent_account_credits
      SET status='approved', reviewed_by=$1, reviewed_at=NOW(), review_notes=$2, updated_at=NOW()
      WHERE id=$3 AND status='pending_approval'
      RETURNING *
    `, [reviewer, notes, req.params.id]);
    if (!rows.length) return res.status(409).json({ error: 'Not found or not pending' });
    res.json(rows[0]);
  } catch (e) {
    console.error('credit approve:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/study/admin/credits/:id/reject — manager rejects the credit
router.post('/admin/credits/:id/reject', authenticate, requireAdmin, async (req, res) => {
  const db = getPool();
  const reviewer = (req.user.first_name ? (req.user.first_name + ' ' + (req.user.last_name||'')).trim() : (req.user.username || 'Manager'));
  const notes = (req.body && req.body.notes) || null;
  try {
    const { rows } = await db.query(`
      UPDATE ladn.parent_account_credits
      SET status='rejected', reviewed_by=$1, reviewed_at=NOW(), review_notes=$2, updated_at=NOW()
      WHERE id=$3 AND status IN ('pending_approval','approved')
      RETURNING *
    `, [reviewer, notes, req.params.id]);
    if (!rows.length) return res.status(409).json({ error: 'Not found or not actionable' });
    res.json(rows[0]);
  } catch (e) {
    console.error('credit reject:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/study/admin/credits/:id/mark-applied — manager records it was applied to an invoice
router.post('/admin/credits/:id/mark-applied', authenticate, requireAdmin, async (req, res) => {
  const db = getPool();
  const invoiceId = (req.body && req.body.invoice_id) || null;
  try {
    const { rows } = await db.query(`
      UPDATE ladn.parent_account_credits
      SET status='applied', applied_invoice_id=$1, updated_at=NOW()
      WHERE id=$2 AND status='approved'
      RETURNING *
    `, [invoiceId, req.params.id]);
    if (!rows.length) return res.status(409).json({ error: 'Not found or not approved' });
    res.json(rows[0]);
  } catch (e) {
    console.error('credit mark-applied:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildRewardData(type, module, childName) {
  const name = childName || 'Your child';
  const categoryLabels = {
    school_readiness: 'School Readiness', behaviour: 'Behaviour', home_learning: 'Home Learning',
    phonics: 'Phonics', nutrition: 'Nutrition', health: 'Health',
    safeguarding_at_home: 'Safeguarding', development_milestones: 'Development',
    wellbeing: 'Wellbeing', transitions: 'Transitions'
  };

  if (type === 'certificate') {
    return {
      child_name: name,
      module_title: module.title,
      category: categoryLabels[module.category] || module.category,
      issued_date: new Date().toLocaleDateString('en-GB'),
      message: `${name} has completed the "${module.title}" module on the Your Nursery Parent Learning Portal.`
    };
  }
  if (type === 'sticker') {
    return {
      child_name: name,
      module_title: module.title,
      sticker_theme: module.category,
      sticker_count: 8,
      message: `${name} completed a learning module!`
    };
  }
  if (type === 'activity_voucher') {
    const activities = {
      phonics: { title: 'Sound Safari Walk', materials: ['notebook or clipboard','pencil'], steps: ['Go for a walk around your neighbourhood.','Listen carefully for sounds — birds, traffic, voices, wind.','For each sound, write or draw it.','Back home: sort sounds into "loud", "quiet", "natural", "man-made".','Extension: think of words that start with each sound you found.'], tag_back: 'Tell your key worker one new sound word you discovered!' },
      behaviour: { title: 'Feelings Weather Chart', materials: ['large paper or whiteboard','coloured pens or stickers'], steps: ['Draw weather symbols: sunshine, clouds, rain, storm, rainbow.','Each morning, ask your child "what\'s your weather today?"','They choose a symbol that matches how they feel.','Talk about why — "what made it cloudy today?"','Celebrate all weathers equally — there\'s no wrong feeling.'], tag_back: 'Tell your key worker what your weather was this morning!' },
      home_learning: { title: 'Kitchen Science Morning', materials: ['bicarbonate of soda','white vinegar','food colouring','cups or ice cube tray'], steps: ['Put bicarbonate of soda in each cup.','Add a few drops of food colouring.','Let your child pour vinegar in — watch it fizz!','Talk about what is happening — bubbles, colour mixing.','Try mixing colours: what happens when red and blue meet?'], tag_back: 'Tell your key worker what colours you made!' },
      school_readiness: { title: 'Independence Morning', materials: ['timer (optional)','sticker chart'], steps: ['Choose one morning this week for your child to do everything themselves.','Getting dressed, putting shoes on, washing hands — all by themselves.','Offer encouragement but let them struggle a little.','Celebrate each success with a sticker.','Repeat daily and watch independence grow week by week.'], tag_back: 'Tell your key worker one thing you did all by yourself!' },
      nutrition: { title: 'Rainbow Plate Challenge', materials: ['variety of fruit and veg','plate','camera or drawing paper'], steps: ['Challenge: can you make a plate with every colour of the rainbow?','Red: tomato or strawberry. Orange: carrot. Yellow: pepper. Green: cucumber. Purple: grapes.','Arrange them in a rainbow arc on the plate.','Take a photo or draw it before eating.','Talk about where each colour comes from.'], tag_back: 'Tell your key worker which rainbow colour you ate today!' },
      development_milestones: { title: 'Treasure Basket Exploration', materials: ['small basket or box','5-8 safe household objects (wooden spoon, sponge, fabric square, metal spoon, etc)'], steps: ['Fill a basket with interesting everyday objects (not toys).','Sit with your baby or toddler on the floor.','Let them explore freely — no instructions needed.','Watch what they pick up, mouth, bang, smell.','Name each object as they hold it: "that\'s a wooden spoon".'], tag_back: 'Tell your key worker what was in your treasure basket!' }
    };
    const a = activities[module.category] || activities.phonics;
    return { child_name: name, module_title: module.title, ...a };
  }
  if (type === 'book_recommendation') {
    const books = {
      behaviour: [
        { title: "The Whole-Brain Child", author: "Daniel J. Siegel & Tina Payne Bryson", synopsis: "12 practical strategies to nurture your child's developing mind. Explains why children behave as they do using neuroscience, and gives parents tools to help children process big emotions." },
        { title: "No Drama Discipline", author: "Daniel J. Siegel & Tina Payne Bryson", synopsis: "Focuses on connecting with children during difficult moments rather than punishing. The authors show how discipline done right actually builds brain connections and self-regulation." },
        { title: "The Explosive Child", author: "Ross W. Greene", synopsis: "A compassionate, practical approach to understanding children with 'collaborative problem-solving' — particularly useful if your child struggles with inflexibility or frustration." }
      ],
      phonics: [
        { title: "Phonics from Scratch", author: "Debbie Hepplewhite", synopsis: "Clear explanation of systematic synthetic phonics for parents. Helps you understand what your child is being taught in school and how to support reading at home." },
        { title: "The Read-Aloud Handbook", author: "Jim Trelease", synopsis: "Why reading aloud to children is the single best way to prepare them for reading success. Full of research and a substantial book list organised by age." },
        { title: "Raising Readers", author: "Jennie Nash", synopsis: "Practical guidance on creating a reading culture at home from birth through primary school, with emphasis on follow-your-child's-interest rather than pushing." }
      ],
      school_readiness: [
        { title: "Settling Into School", author: "Jennie Lindon", synopsis: "Research-based guide to school readiness from a respected early years author. Covers emotional, social, physical and cognitive readiness in an accessible format." },
        { title: "What to Expect in the EYFS", author: "DfE / Helen Moylett & Nancy Stewart", synopsis: "The official practitioner guidance explaining the seven areas of learning and development. Helps parents understand how nurseries and reception classes observe and plan for children." },
        { title: "Upstart: The Case for Raising the School Starting Age", author: "Sue Palmer", synopsis: "A thought-provoking read on why unhurried early years is better for long-term learning. Particularly relevant for families navigating the preschool-to-school transition." }
      ],
      nutrition: [
        { title: "First Steps Nutrition: Eating Well in the Early Years", author: "Frankie Phillips / First Steps Nutrition Trust", synopsis: "Evidence-based UK guide to feeding children from birth to 5. Covers complementary feeding, texture progression, nutrients and practical family meals." },
        { title: "Baby-Led Weaning", author: "Gill Rapley & Tracey Murkett", synopsis: "The foundational text on self-feeding from 6 months. Explains the evidence behind letting babies take the lead, with practical guidance for families." },
        { title: "The Fussy Eater's Recipe Book", author: "Annabel Karmel", synopsis: "Practical, UK-focused recipes for children who resist new foods. Includes strategies for introducing variety without mealtimes becoming a battleground." }
      ]
    };
    const picks = books[module.category] || books.behaviour;
    return { child_name: name, module_title: module.title, books: picks };
  }
  return {};
}

async function generateRewardPDF(reward) {
  const PDFDocument = require('pdfkit');
  const fs = require('fs');
  const path = require('path');

  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: 'A4', margin: 50 });

    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const BLUE   = '#4a9abf';
    const ORANGE = '#e07820';
    const DARK   = '#0f172a';
    const MUTED  = '#64748b';

    const logoPath = '/app/little-angels-logo.png';
    const hasLogo  = fs.existsSync(logoPath);

    // Header bar
    doc.rect(0, 0, doc.page.width, 80).fill(DARK);
    if (hasLogo) {
      try { doc.image(logoPath, 30, 15, { height: 50 }); } catch (_) {}
    }
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22)
       .text('Your Nursery', hasLogo ? 200 : 30, 22)
       .fillColor(ORANGE).text(' Day Nursery', { continued: false });
    doc.fillColor(MUTED).font('Helvetica').fontSize(9)
       .text('1A Example Lane, Ealing, W13 9LU', hasLogo ? 200 : 30, 52);
    doc.y = 110;

    const d = reward.reward_data || {};
    const childName = d.child_name || 'Your child';

    if (reward.reward_type === 'certificate') {
      doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(32)
         .text('Certificate of Completion', { align: 'center' });
      doc.moveDown(0.5);
      doc.fillColor(DARK).font('Helvetica').fontSize(14)
         .text('This certifies that', { align: 'center' });
      doc.moveDown(0.3);
      doc.fillColor(ORANGE).font('Helvetica-Bold').fontSize(26)
         .text(childName, { align: 'center' });
      doc.moveDown(0.3);
      doc.fillColor(DARK).font('Helvetica').fontSize(14)
         .text('has successfully completed', { align: 'center' });
      doc.moveDown(0.3);
      doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(18)
         .text(d.module_title || reward.module_title || 'Parent Learning Module', { align: 'center' });
      doc.moveDown(0.5);
      doc.fillColor(MUTED).font('Helvetica').fontSize(11)
         .text('on the Your Nursery Parent Learning Portal', { align: 'center' });
      doc.moveDown();
      doc.fillColor(MUTED).fontSize(10)
         .text(`Issued: ${d.issued_date || new Date().toLocaleDateString('en-GB')}`, { align: 'center' });
      doc.moveDown(2);
      doc.fillColor(DARK).font('Helvetica-Bold').fontSize(11)
         .text('Nursery Manager — Manager', { align: 'center' });

    } else if (reward.reward_type === 'sticker') {
      doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(24)
         .text(`${childName}'s Sticker Sheet`, { align: 'center' });
      doc.moveDown(0.3);
      doc.fillColor(MUTED).font('Helvetica').fontSize(12)
         .text(`Congratulations on completing "${d.module_title || 'a learning module'}"!`, { align: 'center' });
      doc.moveDown();
      const cols = 4, rows = 2, size = 100, gap = 20;
      const startX = (doc.page.width - (cols * size + (cols - 1) * gap)) / 2;
      let x = startX, y = doc.y;
      const emojis = ['⭐','🌟','🎉','🏆','🌈','🎈','🦋','🌺'];
      for (let i = 0; i < cols * rows; i++) {
        doc.roundedRect(x, y, size, size, 12).fillAndStroke(BLUE + '22', BLUE);
        doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(10)
           .text(emojis[i % emojis.length] + '\n' + (childName.split(' ')[0] || childName),
                 x + 5, y + size / 2 - 15, { width: size - 10, align: 'center' });
        x += size + gap;
        if ((i + 1) % cols === 0) { x = startX; y += size + gap; }
      }
      doc.y = y + size + 20;
      doc.fillColor(MUTED).font('Helvetica').fontSize(9)
         .text('Cut out your stickers and stick them on your work or learning journal!', { align: 'center' });

    } else if (reward.reward_type === 'activity_voucher') {
      doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(24)
         .text('Home Activity Card', { align: 'center' });
      doc.fillColor(ORANGE).font('Helvetica-Bold').fontSize(18)
         .text(d.title || 'Activity', { align: 'center' });
      doc.moveDown(0.3);
      doc.fillColor(MUTED).font('Helvetica').fontSize(11)
         .text(`For: ${childName}`, { align: 'center' });
      doc.moveDown();
      if (d.materials?.length) {
        doc.fillColor(DARK).font('Helvetica-Bold').fontSize(12).text('You will need:');
        d.materials.forEach(m => doc.fillColor(DARK).font('Helvetica').fontSize(11).text('  • ' + m));
        doc.moveDown(0.5);
      }
      if (d.steps?.length) {
        doc.fillColor(DARK).font('Helvetica-Bold').fontSize(12).text('What to do:');
        d.steps.forEach((s, i) => doc.fillColor(DARK).font('Helvetica').fontSize(11).text(`  ${i + 1}. ${s}`));
        doc.moveDown(0.5);
      }
      if (d.tag_back) {
        doc.rect(50, doc.y, doc.page.width - 100, 40).fillAndStroke(ORANGE + '22', ORANGE);
        doc.fillColor(ORANGE).font('Helvetica-Bold').fontSize(10)
           .text('Tag back: ' + d.tag_back, 60, doc.y - 32, { width: doc.page.width - 120 });
        doc.y += 50;
      }

    } else if (reward.reward_type === 'book_recommendation') {
      doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(24)
         .text('Your Book Recommendations', { align: 'center' });
      doc.fillColor(MUTED).font('Helvetica').fontSize(12)
         .text(`Curated for families who completed "${d.module_title || ''}"`, { align: 'center' });
      doc.moveDown();
      (d.books || []).forEach((book, i) => {
        doc.fillColor(DARK).font('Helvetica-Bold').fontSize(13).text(`${i + 1}. ${book.title}`);
        doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(11).text(book.author);
        doc.fillColor(DARK).font('Helvetica').fontSize(11).text(book.synopsis);
        doc.moveDown(0.5);
      });
    }

    // Footer
    doc.rect(0, doc.page.height - 40, doc.page.width, 40).fill(DARK);
    doc.fillColor(MUTED).font('Helvetica').fontSize(8)
       .text('Your Nursery | 1A Example Lane, Ealing W13 9LU | 01234 567890 | example.com',
             30, doc.page.height - 28, { align: 'center' });

    doc.end();
  });
}

module.exports = router;
