'use strict';
// Document Updater & Merger — workspace management + AI analysis pipeline.
// All writes require manager/deputy_manager role.

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');

const { getPool }   = require('../db/pool');
const authenticate  = require('../middleware/auth');
const { ingestDocument } = require('../services/document-parser');

const OLLAMA_URL   = process.env.OLLAMA_HOST || process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_HELPER_MODEL || process.env.OLLAMA_MODEL || 'qwen3.5:4b';
// In container: /app/data → host data/ladn (volume mount). Drop the ladn/ segment.
const UPLOAD_BASE  = process.env.DOC_UPLOAD_BASE
  || path.join(__dirname, '../../data/document-workspace-uploads');
const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';

// ── Multer upload storage ─────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(UPLOAD_BASE, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    cb(null, `upload_${Date.now()}_${Math.random().toString(36).slice(2,7)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = ['.docx', '.pdf', '.md', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (ok.includes(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type "${ext}". Accepted: ${ok.join(', ')}`));
  },
});

router.use(authenticate);

// ── Manager-only guard ────────────────────────────────────────────────────────
function requireManager(req, res, next) {
  if (!['manager', 'deputy_manager'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager access required' });
  next();
}

// ── Ollama call helper ────────────────────────────────────────────────────────
async function ollamaChat(prompt, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, think: false }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
    const data = await resp.json();
    return data.response || '';
  } finally {
    clearTimeout(timer);
  }
}

// Extract JSON from an AI response that may wrap it in ```json ... ```
function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  return JSON.parse(raw.trim());
}

// ── Audit helper ──────────────────────────────────────────────────────────────
async function audit(db, workspaceId, event, detail) {
  await db.query(
    `INSERT INTO ${SCHEMA()}.document_workspace_audit(workspace_id, event, detail)
     VALUES ($1, $2, $3)`,
    [workspaceId, event, JSON.stringify(detail || {})]
  );
}

// ── AI pipeline (runs async after workspace created) ─────────────────────────
async function runAnalysisPipeline(workspaceId) {
  const db = getPool();
  try {
    const { rows: [ws] } = await db.query(
      `SELECT * FROM ${SCHEMA()}.document_workspaces WHERE id=$1`, [workspaceId]
    );
    if (!ws) return;

    // ── Step 1: diff/reconciliation analysis ─────────────────────────────────
    let analysisPrompt;
    if (ws.mode === 'update') {
      analysisPrompt =
        `You are an expert in UK nursery documentation (EYFS, Ofsted, GDPR).\n` +
        `Compare these two versions of a UK nursery ${ws.doc_type}.\n` +
        `Identify:\n` +
        `1) sections added in the update\n` +
        `2) sections removed from the base\n` +
        `3) sections substantively changed — provide before/after and rate significance 'major' or 'minor'\n` +
        `4) total count of sections that appear unchanged\n\n` +
        `Return ONLY valid JSON matching this schema exactly (no explanation, no markdown fence):\n` +
        `{"added":[{"section":string,"content":string}],` +
        `"removed":[{"section":string,"content":string}],` +
        `"changed":[{"section":string,"before":string,"after":string,"significance":"major"|"minor"}],` +
        `"unchanged_count":int}\n\n` +
        `If you are uncertain or the source is ambiguous, prefer to flag a clarifying question rather than guess.\n\n` +
        `BASE VERSION:\n${ws.base_content_md}\n\n` +
        `UPDATE VERSION:\n${ws.update_content_md}`;
    } else {
      // merge mode
      analysisPrompt =
        `You are an expert in UK nursery documentation (EYFS, Ofsted, GDPR).\n` +
        `Two versions of a UK nursery ${ws.doc_type} are provided.\n` +
        `Version A is LADN's current policy. Version B is the Early Years Alliance's updated guidance.\n` +
        `Produce a reconciliation analysis:\n` +
        `1) where LADN already aligns with EYA — no change needed\n` +
        `2) where EYA recommends additions LADN does not have — LADN should adopt\n` +
        `3) where LADN has clauses EYA does not address — keep LADN's own\n` +
        `4) where they directly conflict — flag for human decision with recommendation\n\n` +
        `Return ONLY valid JSON (no explanation, no markdown fence):\n` +
        `{"aligned":[{"section":string,"note":string}],` +
        `"to_adopt":[{"section":string,"eya_content":string}],` +
        `"ladn_only":[{"section":string,"ladn_content":string}],` +
        `"conflicts":[{"section":string,"ladn_version":string,"eya_version":string,"recommendation":string}]}\n\n` +
        `If you are uncertain or the source is ambiguous, prefer to flag a clarifying question rather than guess.\n\n` +
        `LADN CURRENT (Version A):\n${ws.base_content_md}\n\n` +
        `EYA UPDATED (Version B):\n${ws.merge_content_md}`;
    }

    const analysisRaw = await ollamaChat(analysisPrompt, 300000);
    let ai_analysis;
    try { ai_analysis = extractJson(analysisRaw); }
    catch { ai_analysis = { raw: analysisRaw, parse_error: true }; }

    await db.query(
      `UPDATE ${SCHEMA()}.document_workspaces SET ai_analysis=$1, updated_at=now() WHERE id=$2`,
      [JSON.stringify(ai_analysis), workspaceId]
    );
    await audit(db, workspaceId, 'analysed', { model: OLLAMA_MODEL });

    // ── Step 2: generate clarifying questions ─────────────────────────────────
    const questionPrompt =
      `You are an expert in UK nursery ${ws.doc_type} documentation.\n` +
      `Review the following diff/reconciliation analysis between two document versions.\n` +
      `Generate 3–7 specific clarifying questions for the nursery manager BEFORE the new version is adopted.\n` +
      `Focus on: ambiguous changes, deleted clauses that may be intentional, additions that conflict with ` +
      `existing policies, missing legal references, or any uncertainty.\n\n` +
      `Return ONLY a valid JSON array (no explanation, no markdown fence):\n` +
      `[{"id":string,"question":string,"context":string,` +
      `"suggested_options":["option A","option B","option C"]|null,` +
      `"why_we_need_to_know":string}]\n\n` +
      `If you are uncertain or the source is ambiguous, prefer to flag a clarifying question rather than guess.\n\n` +
      `DOC TYPE: ${ws.doc_type}\nMODE: ${ws.mode}\nANALYSIS:\n${JSON.stringify(ai_analysis, null, 2)}`;

    const questionsRaw = await ollamaChat(questionPrompt, 120000);
    let ai_questions;
    try { ai_questions = extractJson(questionsRaw); }
    catch { ai_questions = [{ id: 'q0', question: 'Could not parse questions automatically. Please review the analysis below.', context: questionsRaw, suggested_options: null, why_we_need_to_know: 'Manual review needed.' }]; }

    // Ensure each question has an id
    if (Array.isArray(ai_questions)) {
      ai_questions = ai_questions.map((q, i) => ({ id: q.id || `q${i}`, ...q }));
    }

    await db.query(
      `UPDATE ${SCHEMA()}.document_workspaces SET ai_questions=$1, status='questions_pending', updated_at=now() WHERE id=$2`,
      [JSON.stringify(ai_questions), workspaceId]
    );
    await audit(db, workspaceId, 'questions_asked', { count: Array.isArray(ai_questions) ? ai_questions.length : 0 });

  } catch (err) {
    console.error(`[doc-workspaces] pipeline error for workspace ${workspaceId}:`, err.message);
    await db.query(
      `UPDATE ${SCHEMA()}.document_workspaces SET status='error', ai_analysis=$1, updated_at=now() WHERE id=$2`,
      [JSON.stringify({ error: err.message }), workspaceId]
    ).catch(() => {});
  }
}

// ── Generate proposed output (Step 4) ────────────────────────────────────────
async function generateProposedOutput(workspaceId) {
  const db = getPool();
  try {
    const { rows: [ws] } = await db.query(
      `SELECT * FROM ${SCHEMA()}.document_workspaces WHERE id=$1`, [workspaceId]
    );
    if (!ws) return;

    await db.query(
      `UPDATE ${SCHEMA()}.document_workspaces SET status='analysing', updated_at=now() WHERE id=$1`,
      [workspaceId]
    );

    const qaText = Array.isArray(ws.ai_questions)
      ? ws.ai_questions.map((q, i) => {
          const ans = ws.user_answers ? ws.user_answers[q.id] : null;
          return `Q${i+1}: ${q.question}\nAnswer: ${ans || '(no answer provided)'}`;
        }).join('\n\n')
      : '(no Q&A available)';

    const secondSource = ws.mode === 'merge' ? ws.merge_content_md : ws.update_content_md;

    const outputPrompt =
      `You are an expert in UK nursery documentation (EYFS, Ofsted, GDPR).\n` +
      `Produce the final reconciled ${ws.doc_type} document.\n\n` +
      `Rules:\n` +
      `- Preserve all clauses the manager wants kept (see Q&A below)\n` +
      `- Incorporate all updates the manager confirmed\n` +
      `- Format consistently in clean markdown with proper headings and sections\n` +
      `- Do NOT add commentary, preamble, or explanation — return ONLY the final document markdown\n` +
      `- If you are uncertain or the source is ambiguous, prefer to flag it inline as [REVIEW NEEDED: reason]\n\n` +
      `BASE DOCUMENT:\n${ws.base_content_md}\n\n` +
      `${ws.mode === 'merge' ? 'EYA GUIDANCE' : 'UPDATED VERSION'}:\n${secondSource}\n\n` +
      `MANAGER Q&A:\n${qaText}\n\n` +
      `ANALYSIS SUMMARY:\n${JSON.stringify(ws.ai_analysis, null, 2)}\n\n` +
      `Return ONLY the final document in markdown format:`;

    const proposed = await ollamaChat(outputPrompt, 300000);

    await db.query(
      `UPDATE ${SCHEMA()}.document_workspaces SET proposed_output_md=$1, status='awaiting_approval', updated_at=now() WHERE id=$2`,
      [proposed.trim(), workspaceId]
    );
    await audit(db, workspaceId, 'proposed', { length: proposed.length });

  } catch (err) {
    console.error(`[doc-workspaces] propose error for ${workspaceId}:`, err.message);
    await db.query(
      `UPDATE ${SCHEMA()}.document_workspaces SET status='error', updated_at=now() WHERE id=$1`,
      [workspaceId]
    ).catch(() => {});
  }
}

// ── Telegram helper ───────────────────────────────────────────────────────────
async function telegram(msg) {
  const token   = process.env.TELEGRAM_BOT_TOKEN;
  const chat_id = process.env.TELEGRAM_CHAT_ID || '';
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text: msg }),
    });
  } catch {}
}

// ── Commit to target table ────────────────────────────────────────────────────
async function commitWorkspace(ws, db) {
  const { doc_type, name, proposed_output_md, created_by } = ws;
  const sc = SCHEMA();

  // Safety: no empty output
  if (!proposed_output_md || proposed_output_md.trim().length < 10)
    throw new Error('Proposed output is empty — cannot commit.');

  // Safety: policy must mention safeguarding or data protection
  if (doc_type === 'policy') {
    const lower = proposed_output_md.toLowerCase();
    if (!/safeguarding/.test(lower) && !/data protection/.test(lower)) {
      // Soft warning — attach to response but don't hard-block
      console.warn(`[doc-workspaces] WARNING: policy "${name}" does not reference safeguarding or data protection`);
    }
  }

  let targetTable, targetId;

  if (doc_type === 'handbook') {
    // Flip previous current off, insert new version
    await db.query(`UPDATE ${sc}.staff_handbook_versions SET is_current=false`);
    const { rows: [prev] } = await db.query(
      `SELECT COALESCE(MAX(version),0) AS v FROM ${sc}.staff_handbook_versions`
    );
    const newVersion = prev.v + 1;

    let pdfPath = null;
    try { pdfPath = await generatePdf(proposed_output_md, `handbook_v${newVersion}`); } catch (e) { console.warn('PDF gen failed:', e.message); }

    const { rows: [row] } = await db.query(
      `INSERT INTO ${sc}.staff_handbook_versions(version, title, content_md, pdf_path, is_current, published_by, published_at)
       VALUES($1,$2,$3,$4,true,$5,now()) RETURNING id`,
      [newVersion, name, proposed_output_md, pdfPath, created_by]
    );
    targetTable = 'staff_handbook_versions';
    targetId = row.id;

  } else if (doc_type === 'policy') {
    // Check if policy exists (by name) — update or insert
    const { rows: [existing] } = await db.query(
      `SELECT id, version FROM ${sc}.policies WHERE title=$1 LIMIT 1`, [name]
    );
    let pdfPath = null;
    try { pdfPath = await generatePdf(proposed_output_md, `policy_${Date.now()}`); } catch (e) { console.warn('PDF gen failed:', e.message); }

    if (existing) {
      await db.query(
        `UPDATE ${sc}.policies SET content=$1, version=version+1, published_at=now(), is_active=true WHERE id=$2`,
        [proposed_output_md, existing.id]
      );
      targetTable = 'policies';
      targetId = existing.id;
    } else {
      const { rows: [row] } = await db.query(
        `INSERT INTO ${sc}.policies(title, content, version, category, is_active, published_at)
         VALUES($1,$2,1,'general',true,now()) RETURNING id`,
        [name, proposed_output_md]
      );
      targetTable = 'policies';
      targetId = row.id;
    }

  } else if (doc_type === 'contract_template') {
    // Deactivate previous, insert new version
    await db.query(`UPDATE ${sc}.contract_templates SET is_active=false WHERE name=$1`, [name]);
    const { rows: [prev] } = await db.query(
      `SELECT COALESCE(MAX(version),0) AS v FROM ${sc}.contract_templates WHERE name=$1`, [name]
    );
    const newVersion = prev.v + 1;

    let pdfPath = null;
    try { pdfPath = await generatePdf(proposed_output_md, `contract_${newVersion}`); } catch (e) { console.warn('PDF gen failed:', e.message); }

    const { rows: [row] } = await db.query(
      `INSERT INTO ${sc}.contract_templates(name, doc_type, content_md, version, is_active, pdf_path)
       VALUES($1,'contract_template',$2,$3,true,$4) RETURNING id`,
      [name, proposed_output_md, newVersion, pdfPath]
    );
    targetTable = 'contract_templates';
    targetId = row.id;

  } else {
    // Generic: store as a policy entry with category = doc_type
    let pdfPath = null;
    try { pdfPath = await generatePdf(proposed_output_md, `doc_${Date.now()}`); } catch (e) { console.warn('PDF gen failed:', e.message); }

    const { rows: [existing] } = await db.query(
      `SELECT id FROM ${sc}.policies WHERE title=$1 LIMIT 1`, [name]
    );
    if (existing) {
      await db.query(
        `UPDATE ${sc}.policies SET content=$1, version=version+1, published_at=now(), is_active=true WHERE id=$2`,
        [proposed_output_md, existing.id]
      );
      targetTable = 'policies';
      targetId = existing.id;
    } else {
      const { rows: [row] } = await db.query(
        `INSERT INTO ${sc}.policies(title, content, version, category, is_active, published_at)
         VALUES($1,$2,1,$3,true,now()) RETURNING id`,
        [name, proposed_output_md, doc_type]
      );
      targetTable = 'policies';
      targetId = row.id;
    }
  }

  return { targetTable, targetId };
}

// ── PDF generation helper ─────────────────────────────────────────────────────
async function generatePdf(markdownText, baseName) {
  const PDFDocument = require('pdfkit');
  const pdfDir = path.join(UPLOAD_BASE, 'committed-pdfs');
  fs.mkdirSync(pdfDir, { recursive: true });
  const pdfPath = path.join(pdfDir, `${baseName}_${Date.now()}.pdf`);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 60, size: 'A4' });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    // Simple markdown → PDF: headings and paragraphs
    const lines = markdownText.split('\n');
    for (const line of lines) {
      if (line.startsWith('# '))       { doc.fontSize(18).font('Helvetica-Bold').text(line.slice(2)).moveDown(0.4); }
      else if (line.startsWith('## ')) { doc.fontSize(14).font('Helvetica-Bold').text(line.slice(3)).moveDown(0.3); }
      else if (line.startsWith('### ')){ doc.fontSize(12).font('Helvetica-Bold').text(line.slice(4)).moveDown(0.2); }
      else if (line.trim() === '')     { doc.moveDown(0.5); }
      else                             { doc.fontSize(10).font('Helvetica').text(line, { align: 'justify' }).moveDown(0.2); }
    }

    doc.end();
    stream.on('finish', () => resolve(pdfPath));
    stream.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/documents/workspaces — create workspace + kick off async analysis
router.post('/', requireManager, upload.fields([
  { name: 'base_file',   maxCount: 1 },
  { name: 'update_file', maxCount: 1 },
  { name: 'merge_file',  maxCount: 1 },
]), async (req, res) => {
  const { doc_type, mode, base_table, base_id, name } = req.body;
  if (!doc_type || !mode || !name)
    return res.status(400).json({ error: 'doc_type, mode, and name are required' });
  if (!['update', 'merge'].includes(mode))
    return res.status(400).json({ error: 'mode must be "update" or "merge"' });

  const db = getPool();
  try {
    // Resolve base content: from DB row or uploaded file
    let base_content_md = null, base_doc_path = null;
    let update_content_md = null, update_doc_path = null;
    let merge_content_md = null, merge_doc_path = null;

    // Base from existing DB record
    if (base_table && base_id) {
      const sc = SCHEMA();
      let row;
      if (base_table === 'policies') {
        const { rows } = await db.query(`SELECT content AS content_md FROM ${sc}.policies WHERE id=$1`, [base_id]);
        row = rows[0];
      } else if (base_table === 'staff_handbook_versions') {
        const { rows } = await db.query(`SELECT content_md FROM ${sc}.staff_handbook_versions WHERE id=$1`, [base_id]);
        row = rows[0];
      } else if (base_table === 'contract_templates') {
        const { rows } = await db.query(`SELECT content_md FROM ${sc}.contract_templates WHERE id=$1`, [base_id]);
        row = rows[0];
      }
      if (row) { base_content_md = row.content_md; base_doc_path = `db:${base_table}:${base_id}`; }
    }

    // Base from uploaded file
    if (!base_content_md && req.files?.base_file?.[0]) {
      const f = req.files.base_file[0];
      const parsed = await ingestDocument(f.path);
      base_content_md = parsed.content_md;
      base_doc_path   = f.path;
    }

    if (!base_content_md)
      return res.status(400).json({ error: 'Base document required (upload base_file or provide base_table+base_id)' });

    // Update file (for update mode)
    if (req.files?.update_file?.[0]) {
      const f = req.files.update_file[0];
      const parsed = await ingestDocument(f.path);
      update_content_md = parsed.content_md;
      update_doc_path   = f.path;
    }
    if (mode === 'update' && !update_content_md)
      return res.status(400).json({ error: 'update_file is required for update mode' });

    // Merge file (for merge mode)
    if (req.files?.merge_file?.[0]) {
      const f = req.files.merge_file[0];
      const parsed = await ingestDocument(f.path);
      merge_content_md = parsed.content_md;
      merge_doc_path   = f.path;
    }
    if (mode === 'merge' && !merge_content_md)
      return res.status(400).json({ error: 'merge_file is required for merge mode' });

    const { rows: [ws] } = await db.query(
      `INSERT INTO ${SCHEMA()}.document_workspaces
         (name, doc_type, base_doc_path, base_content_md,
          update_doc_path, update_content_md,
          merge_doc_path, merge_content_md,
          mode, status, created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'analysing',$10) RETURNING id`,
      [name, doc_type, base_doc_path, base_content_md,
       update_doc_path, update_content_md,
       merge_doc_path, merge_content_md,
       mode, req.user.id]
    );
    await audit(db, ws.id, 'created', { doc_type, mode, created_by: req.user.id });

    // Kick off async — don't await
    setImmediate(() => runAnalysisPipeline(ws.id));

    res.status(201).json({ id: ws.id, status: 'analysing' });
  } catch (err) {
    console.error('[doc-workspaces] create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /sources/list — list available base documents (policies + handbook)
// MUST be before /:id to avoid ambiguity
router.get('/sources/list', requireManager, async (req, res) => {
  const db = getPool();
  const sc = SCHEMA();
  try {
    const [policies, handbook, contracts] = await Promise.all([
      db.query(`SELECT id, title AS name, version, 'policies' AS source_table FROM ${sc}.policies WHERE is_active=true ORDER BY title`),
      db.query(`SELECT id, title AS name, version, 'staff_handbook_versions' AS source_table FROM ${sc}.staff_handbook_versions WHERE is_current=true ORDER BY version DESC LIMIT 1`),
      db.query(`SELECT id, name, version, 'contract_templates' AS source_table FROM ${sc}.contract_templates WHERE is_active=true ORDER BY name`).catch(() => ({ rows: [] })),
    ]);
    res.json({
      policies:  policies.rows,
      handbook:  handbook.rows,
      contracts: contracts.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/workspaces — list all (manager)
router.get('/', requireManager, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT w.id, w.name, w.doc_type, w.mode, w.status, w.created_at, w.updated_at,
              COALESCE(s.preferred_name, s.first_name, '') || ' ' || COALESCE(s.last_name,'') AS created_by_name
       FROM ${SCHEMA()}.document_workspaces w
       LEFT JOIN ${SCHEMA()}.staff s ON s.id=w.created_by
       ORDER BY w.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/workspaces/:id — single workspace
router.get('/:id', requireManager, async (req, res) => {
  const db = getPool();
  try {
    const { rows: [ws] } = await db.query(
      `SELECT w.*, COALESCE(s.preferred_name, s.first_name, '') || ' ' || COALESCE(s.last_name,'') AS created_by_name
       FROM ${SCHEMA()}.document_workspaces w
       LEFT JOIN ${SCHEMA()}.staff s ON s.id=w.created_by
       WHERE w.id=$1`,
      [req.params.id]
    );
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });

    const { rows: auditRows } = await db.query(
      `SELECT * FROM ${SCHEMA()}.document_workspace_audit WHERE workspace_id=$1 ORDER BY event_at ASC`,
      [req.params.id]
    );
    res.json({ ...ws, audit: auditRows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documents/workspaces/:id/answers — submit Q&A, triggers Step 4
router.post('/:id/answers', requireManager, async (req, res) => {
  const { answers } = req.body;
  if (!answers || typeof answers !== 'object')
    return res.status(400).json({ error: 'answers object required' });

  const db = getPool();
  try {
    const { rows: [ws] } = await db.query(
      `SELECT id, status, ai_questions FROM ${SCHEMA()}.document_workspaces WHERE id=$1`, [req.params.id]
    );
    if (!ws) return res.status(404).json({ error: 'Not found' });
    if (ws.status !== 'questions_pending')
      return res.status(400).json({ error: `Cannot answer questions in status "${ws.status}"` });

    // Validate all questions are answered
    const questions = ws.ai_questions || [];
    const unanswered = questions.filter(q => !answers[q.id] || String(answers[q.id]).trim() === '');
    if (unanswered.length > 0)
      return res.status(400).json({
        error: 'All questions must be answered before proceeding',
        unanswered: unanswered.map(q => q.id),
      });

    await db.query(
      `UPDATE ${SCHEMA()}.document_workspaces SET user_answers=$1, updated_at=now() WHERE id=$2`,
      [JSON.stringify(answers), req.params.id]
    );
    await audit(db, ws.id, 'answered', { count: Object.keys(answers).length });

    // Kick off Step 4 async
    setImmediate(() => generateProposedOutput(ws.id));

    res.json({ status: 'analysing', message: 'Answers saved. Generating proposed document…' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documents/workspaces/:id/edit-proposed — manager edits proposed output
router.post('/:id/edit-proposed', requireManager, async (req, res) => {
  const { proposed_output_md } = req.body;
  if (!proposed_output_md) return res.status(400).json({ error: 'proposed_output_md required' });

  const db = getPool();
  try {
    const { rows: [ws] } = await db.query(
      `SELECT id, status FROM ${SCHEMA()}.document_workspaces WHERE id=$1`, [req.params.id]
    );
    if (!ws) return res.status(404).json({ error: 'Not found' });
    if (!['awaiting_approval', 'questions_pending'].includes(ws.status))
      return res.status(400).json({ error: `Cannot edit in status "${ws.status}"` });

    await db.query(
      `UPDATE ${SCHEMA()}.document_workspaces SET proposed_output_md=$1, status='awaiting_approval', updated_at=now() WHERE id=$2`,
      [proposed_output_md, req.params.id]
    );
    await audit(db, ws.id, 'edited', { chars: proposed_output_md.length });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documents/workspaces/:id/commit — approve and commit
router.post('/:id/commit', requireManager, async (req, res) => {
  const db = getPool();
  try {
    const { rows: [ws] } = await db.query(
      `SELECT * FROM ${SCHEMA()}.document_workspaces WHERE id=$1`, [req.params.id]
    );
    if (!ws) return res.status(404).json({ error: 'Not found' });
    if (ws.status !== 'awaiting_approval')
      return res.status(400).json({ error: `Can only commit from awaiting_approval status (current: ${ws.status})` });

    // Safety: all questions answered
    const questions = ws.ai_questions || [];
    const answers   = ws.user_answers || {};
    const unanswered = questions.filter(q => !answers[q.id]);
    if (unanswered.length > 0)
      return res.status(400).json({ error: 'All AI questions must be answered before committing', unanswered: unanswered.map(q => q.id) });

    // Safety: non-empty output
    if (!ws.proposed_output_md || ws.proposed_output_md.trim().length < 10)
      return res.status(400).json({ error: 'Proposed output is empty — cannot commit' });

    // Soft warning for policy missing safeguarding / data protection refs
    const warnings = [];
    if (ws.doc_type === 'policy') {
      const lower = ws.proposed_output_md.toLowerCase();
      if (!/safeguarding/.test(lower) && !/data protection/.test(lower)) {
        warnings.push('Policy does not reference "safeguarding" or "data protection". Please review before proceeding.');
      }
    }

    const { targetTable, targetId } = await commitWorkspace(ws, db);

    await db.query(
      `UPDATE ${SCHEMA()}.document_workspaces
       SET status='committed', committed_to_table=$1, committed_to_id=$2, updated_at=now()
       WHERE id=$3`,
      [targetTable, targetId, ws.id]
    );
    await audit(db, ws.id, 'committed', { targetTable, targetId });

    // Count changes for Telegram
    const analysis = ws.ai_analysis || {};
    const changeCount = (
      (analysis.added?.length || 0) +
      (analysis.removed?.length || 0) +
      (analysis.changed?.length || 0) +
      (analysis.to_adopt?.length || 0) +
      (analysis.conflicts?.length || 0)
    );

    await telegram(
      `📄 ${ws.doc_type} '${ws.name}' updated by ${ws.created_by_name || 'manager'}.\n` +
      `Committed to ${targetTable} (id: ${targetId}). ~${changeCount} section changes.\n` +
      `Workspace: /admin/documents/workspaces/${ws.id}`
    );

    res.json({ ok: true, targetTable, targetId, warnings });
  } catch (err) {
    console.error('[doc-workspaces] commit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documents/workspaces/:id/cancel
router.post('/:id/cancel', requireManager, async (req, res) => {
  const db = getPool();
  try {
    const { rows: [ws] } = await db.query(
      `SELECT id, status FROM ${SCHEMA()}.document_workspaces WHERE id=$1`, [req.params.id]
    );
    if (!ws) return res.status(404).json({ error: 'Not found' });
    if (ws.status === 'committed') return res.status(400).json({ error: 'Cannot cancel a committed workspace' });

    await db.query(
      `UPDATE ${SCHEMA()}.document_workspaces SET status='cancelled', updated_at=now() WHERE id=$1`, [req.params.id]
    );
    await audit(db, ws.id, 'cancelled', {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/workspaces/:id/download — export proposed/committed as .md
router.get('/:id/download', requireManager, async (req, res) => {
  const db = getPool();
  try {
    const { rows: [ws] } = await db.query(
      `SELECT name, proposed_output_md, status FROM ${SCHEMA()}.document_workspaces WHERE id=$1`,
      [req.params.id]
    );
    if (!ws) return res.status(404).json({ error: 'Not found' });
    if (!ws.proposed_output_md) return res.status(400).json({ error: 'No proposed output yet' });

    const safeName = ws.name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    const fmt = req.query.format || 'md';

    if (fmt === 'pdf') {
      try {
        const pdfPath = await generatePdf(ws.proposed_output_md, safeName);
        res.download(pdfPath, `${safeName}.pdf`);
      } catch (err) {
        res.status(500).json({ error: 'PDF generation failed: ' + err.message });
      }
      return;
    }

    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.md"`);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(ws.proposed_output_md);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
