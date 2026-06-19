'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const multer = require('multer');
const nodemailer = require('nodemailer');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit, diffObjects } = require('../utils/audit');

const ADMIN_ROLES = new Set(['manager', 'deputy_manager', 'admin']);

const VALID_FIELD_TYPES = new Set([
  'text', 'long_text', 'number', 'date', 'datetime', 'timestamp_auto',
  'yes_no', 'dropdown', 'radio', 'photo', 'photo_multi', 'signature'
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function canUserDo(mod, user, action, portal) {
  const perms = mod.permissions;
  if (!perms || !portal) return false;
  const portalPerms = perms[portal];
  if (!portalPerms) return false;
  const rolePerms = portalPerms[user.role];
  if (!Array.isArray(rolePerms)) return false;
  return rolePerms.includes(action);
}

function validateRecordData(fields, data) {
  const errors = [];
  for (const field of fields) {
    if (field.type === 'timestamp_auto') continue;
    const val = data[field.key];
    const present = val !== undefined && val !== null && val !== '';
    if (field.required && !present) {
      errors.push(`Field "${field.label || field.key}" is required`);
      continue;
    }
    if (!present) continue;
    if (field.type === 'number' && isNaN(Number(val))) {
      errors.push(`Field "${field.key}" must be a number`);
    }
    if ((field.type === 'dropdown' || field.type === 'radio') && Array.isArray(field.options) && !field.options.includes(String(val))) {
      errors.push(`Field "${field.key}" must be one of: ${field.options.join(', ')}`);
    }
    if (field.type === 'yes_no' && typeof val !== 'boolean') {
      errors.push(`Field "${field.key}" must be true or false`);
    }
  }
  return errors;
}

// ─── Multer ───────────────────────────────────────────────────────────────────

const PHOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const SIG_MIMES = new Set(['image/png']);

const moduleUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const slug = req.wrenModule ? req.wrenModule.slug : 'unknown';
    const recordId = req.params.recordId || 'new';
    const dir = `/app/uploads/modules/${slug}/${recordId}`;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const raw = (req.query.field_key || file.fieldname || 'file')
      .replace(/[^a-z0-9_-]/gi, '_').slice(0, 50);
    cb(null, `${raw}_${Date.now()}${ext}`);
  }
});

const fileUpload = multer({
  storage: moduleUploadStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const fieldKey = req.query.field_key || file.fieldname || '';
    const isSignature = (() => {
      if (!req.wrenModule) return false;
      const fld = (req.wrenModule.fields || []).find(f => f.key === fieldKey);
      return fld && fld.type === 'signature';
    })();
    const allowed = isSignature ? SIG_MIMES : PHOTO_MIMES;
    if (allowed.has(file.mimetype)) {
      cb(null, true);
    } else {
      const err = new Error(`Invalid file type: ${file.mimetype}`);
      err.status = 415;
      cb(err);
    }
  }
});

// ─── Middleware ───────────────────────────────────────────────────────────────

async function loadModule(req, res, next) {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM modules WHERE id=$1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Module not found' });
    req.wrenModule = rows[0];
    next();
  } catch (e) { next(e); }
}

function requireAdmin(req, res, next) {
  if (!ADMIN_ROLES.has(req.user.role)) {
    return res.status(403).json({ error: 'Admin role required' });
  }
  next();
}

// ─── Main Router ──────────────────────────────────────────────────────────────

const router = express.Router();
router.use(authenticate);

// GET / — list modules (filter by ?portal=ey&active=true)
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const { portal, active = 'true' } = req.query;
    const conditions = [];
    const vals = [];

    if (active === 'true') conditions.push('is_active = true');
    if (portal) {
      vals.push(JSON.stringify([portal]));
      conditions.push(`portals @> $${vals.length}::jsonb`);
    }

    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await db.query(`SELECT * FROM modules${where} ORDER BY name`, vals);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST / — create module (admin only)
router.post('/', requireAdmin, async (req, res) => {
  try {
    const db = getPool();
    let { slug, name, description, icon, attaches_to,
          portals = [], permissions = {}, fields = [],
          workflows = [], ai_prompts = [] } = req.body;

    if (!name) return res.status(400).json({ error: 'name required' });
    if (!attaches_to) return res.status(400).json({ error: 'attaches_to required' });
    if (!slug) slug = generateSlug(name);

    for (const field of fields) {
      if (field.type && !VALID_FIELD_TYPES.has(field.type)) {
        return res.status(400).json({ error: `Invalid field type: ${field.type}` });
      }
    }

    const { rows } = await db.query(`
      INSERT INTO modules
        (slug, name, description, icon, attaches_to, portals, permissions, fields, workflows, ai_prompts, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [slug, name, description, icon, attaches_to,
        JSON.stringify(portals), JSON.stringify(permissions),
        JSON.stringify(fields), JSON.stringify(workflows), JSON.stringify(ai_prompts),
        req.user.id]);

    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Slug already exists' });
    res.status(500).json({ error: e.message });
  }
});

// GET /by-slug/:slug — must be before /:id
router.get('/by-slug/:slug', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM modules WHERE slug=$1',
      [req.params.slug]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Module Templates — must be before /:id ───────────────────────────────────

const yaml = require('js-yaml');
const TEMPLATES_DIR = path.join(__dirname, '../../shared/data/module-templates');

function loadTemplates() {
  try {
    const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.yml'));
    return files.map(file => {
      const raw = fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8');
      return yaml.load(raw);
    });
  } catch (e) {
    return [];
  }
}

// GET /templates — list all templates with is_installed flag
router.get('/templates', requireAdmin, async (req, res) => {
  try {
    const templates = loadTemplates();
    if (!templates.length) return res.json([]);

    const slugs = templates.map(t => t.slug);
    const { rows } = await getPool().query(
      `SELECT slug, id, is_active FROM modules WHERE slug = ANY($1) AND is_template = true`,
      [slugs]
    );
    const installed = {};
    rows.forEach(r => { installed[r.slug] = r; });

    const result = templates.map(t => ({
      ...t,
      is_installed: !!installed[t.slug],
      installed_id: installed[t.slug] ? installed[t.slug].id : null,
      is_active: installed[t.slug] ? installed[t.slug].is_active : false,
    }));

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /templates/:slug/enable — install a template as an active module
router.post('/templates/:slug/enable', requireAdmin, async (req, res) => {
  try {
    const templates = loadTemplates();
    const tpl = templates.find(t => t.slug === req.params.slug);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });

    const db = getPool();

    const { rows: existing } = await db.query(
      `SELECT id FROM modules WHERE slug=$1 AND is_template=true`,
      [tpl.slug]
    );
    if (existing.length) {
      return res.status(409).json({ error: 'Template already installed', module_id: existing[0].id });
    }

    const { rows } = await db.query(`
      INSERT INTO modules
        (slug, name, description, icon, attaches_to, portals, permissions, fields,
         workflows, ai_prompts, is_active, is_template, template_category, template_description, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,true,$11,$12,$13)
      RETURNING *
    `, [
      tpl.slug,
      tpl.name,
      tpl.description || '',
      tpl.icon || '',
      tpl.attaches_to || 'general',
      JSON.stringify(tpl.portals || []),
      JSON.stringify(tpl.permissions || {}),
      JSON.stringify(tpl.fields || []),
      JSON.stringify([]),
      JSON.stringify([]),
      tpl.category || null,
      tpl.description || null,
      req.user.id,
    ]);

    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Slug already exists' });
    res.status(500).json({ error: e.message });
  }
});

// POST /templates/:slug/sync — overwrite installed module with latest template (destructive)
router.post('/templates/:slug/sync', requireAdmin, async (req, res) => {
  try {
    const templates = loadTemplates();
    const tpl = templates.find(t => t.slug === req.params.slug);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });

    const db = getPool();
    const { rows: existing } = await db.query(
      `SELECT id FROM modules WHERE slug=$1 AND is_template=true`,
      [tpl.slug]
    );
    if (!existing.length) return res.status(404).json({ error: 'Template not installed — use /enable first' });

    const { rows } = await db.query(`
      UPDATE modules SET
        name=$1, description=$2, icon=$3, attaches_to=$4,
        portals=$5, permissions=$6, fields=$7,
        template_category=$8, template_description=$9,
        updated_at=NOW(), updated_by=$10
      WHERE id=$11
      RETURNING *
    `, [
      tpl.name, tpl.description || '', tpl.icon || '', tpl.attaches_to || 'general',
      JSON.stringify(tpl.portals || []), JSON.stringify(tpl.permissions || {}),
      JSON.stringify(tpl.fields || []),
      tpl.category || null, tpl.description || null,
      req.user.id, existing[0].id,
    ]);

    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM modules WHERE id=$1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id — update (admin only)
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const db = getPool();
    const allowed = ['name','description','icon','attaches_to','portals','permissions','fields','workflows','ai_prompts','is_active'];
    const updates = [];
    const vals = [];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        const v = typeof req.body[key] === 'object' && req.body[key] !== null
          ? JSON.stringify(req.body[key]) : req.body[key];
        vals.push(v);
        updates.push(`${key}=$${vals.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    if (req.body.fields) {
      for (const field of req.body.fields) {
        if (field.type && !VALID_FIELD_TYPES.has(field.type)) {
          return res.status(400).json({ error: `Invalid field type: ${field.type}` });
        }
      }
    }

    vals.push(new Date());
    updates.push(`updated_at=$${vals.length}`);
    vals.push(req.user.id);
    updates.push(`updated_by=$${vals.length}`);
    vals.push(req.params.id);

    const { rows } = await db.query(
      `UPDATE modules SET ${updates.join(',')} WHERE id=$${vals.length} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id — soft-delete (admin only; never hard delete)
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'UPDATE modules SET is_active=false, updated_at=NOW(), updated_by=$1 WHERE id=$2 RETURNING id',
      [req.user.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Records ─────────────────────────────────────────────────────────────────

// GET /:id/records — supports ?view=<viewId>, ?filter[field]=val, ?sort=field:asc|desc
router.get('/:id/records', loadModule, async (req, res) => {
  const portal = req.query.portal || process.env.WREN_EDITION || '';
  const isAdmin = ADMIN_ROLES.has(req.user.role);
  const canViewAll = isAdmin || canUserDo(req.wrenModule, req.user, 'view_all', portal);
  const canViewOwn = canUserDo(req.wrenModule, req.user, 'view_own', portal);

  if (!canViewAll && !canViewOwn) {
    return res.status(403).json({ error: 'No view permission' });
  }

  try {
    const db = getPool();
    const { entity_type, entity_id, limit = 50, offset = 0, submitted_after, view: viewId, sort: sortParam } = req.query;

    // If a saved view is specified, load its filter/sort
    let viewFilter = {};
    let viewSort = null;
    if (viewId) {
      const { rows: vrows } = await db.query(
        'SELECT * FROM module_views WHERE id=$1 AND module_id=$2',
        [viewId, req.params.id]
      );
      if (vrows.length) {
        const vw = vrows[0];
        const fj = vw.filter_json;
        viewFilter = (typeof fj === 'string') ? JSON.parse(fj) : (fj || {});
        const sj = vw.sort;
        viewSort = (typeof sj === 'string') ? JSON.parse(sj) : (sj || null);
      }
    }

    // Ad-hoc filter from ?filter[field]=value query params
    const adHocFilter = {};
    const filterParam = req.query.filter;
    if (filterParam && typeof filterParam === 'object') {
      Object.assign(adHocFilter, filterParam);
    }
    const combinedFilter = Object.assign({}, viewFilter, adHocFilter);

    const conditions = ['mr.module_id=$1', 'mr.is_deleted=false'];
    const vals = [req.params.id];

    if (entity_type) { vals.push(entity_type); conditions.push(`mr.entity_type=$${vals.length}`); }
    if (entity_id)   { vals.push(entity_id);   conditions.push(`mr.entity_id=$${vals.length}`); }
    if (submitted_after) { vals.push(submitted_after); conditions.push(`mr.submitted_at>$${vals.length}`); }
    if (!canViewAll) { vals.push(req.user.id); conditions.push(`mr.submitted_by=$${vals.length}`); }

    // Apply JSONB data filters
    for (const [field, value] of Object.entries(combinedFilter)) {
      if (value === '' || value === undefined) continue;
      vals.push(String(value));
      conditions.push(`mr.data->>'${field.replace(/'/g, "''")}' = $${vals.length}`);
    }

    // Sort: view sort > ?sort param > default submitted_at DESC
    let orderBy = 'mr.submitted_at DESC';
    const effectiveSort = viewSort || sortParam;
    if (effectiveSort) {
      const sortArr = Array.isArray(effectiveSort) ? effectiveSort : [effectiveSort];
      const parts = sortArr.map(s => {
        const [field, dir] = String(s).split(':');
        const safeDir = (dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        if (field === 'submitted_at' || field === 'updated_at') {
          return `mr.${field} ${safeDir}`;
        }
        return `mr.data->>'${field.replace(/'/g, "''")}' ${safeDir}`;
      });
      if (parts.length) orderBy = parts.join(', ');
    }

    const lim = Math.min(parseInt(limit) || 50, 200);
    const off = parseInt(offset) || 0;
    vals.push(lim, off);

    const { rows } = await db.query(`
      SELECT mr.*, s.first_name || ' ' || s.last_name AS submitted_by_name
      FROM module_records mr
      LEFT JOIN staff s ON s.id = mr.submitted_by
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${vals.length - 1} OFFSET $${vals.length}
    `, vals);

    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/records
router.post('/:id/records', loadModule, async (req, res) => {
  const portal = req.query.portal || process.env.WREN_EDITION || '';
  const isAdmin = ADMIN_ROLES.has(req.user.role);
  if (!isAdmin && !canUserDo(req.wrenModule, req.user, 'submit', portal)) {
    return res.status(403).json({ error: 'No submit permission' });
  }

  try {
    const db = getPool();
    const { entity_type, entity_id, related_ids = {}, data = {} } = req.body;
    const fields = req.wrenModule.fields || [];

    for (const field of fields) {
      if (field.type === 'timestamp_auto') data[field.key] = new Date().toISOString();
    }

    const errors = validateRecordData(fields, data);
    if (errors.length) return res.status(422).json({ errors });

    const { rows } = await db.query(`
      INSERT INTO module_records
        (module_id, entity_type, entity_id, related_ids, data, submitted_by, submitted_portal)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `, [req.params.id, entity_type || null, entity_id || null,
        JSON.stringify(related_ids), JSON.stringify(data),
        req.user.id, portal || null]);

    const record = rows[0];
    res.status(201).json(record);

    recordAudit({ req, action: 'create', entity_type: 'module_record', entity_id: record.id,
      meta: { module_id: req.params.id, module_name: req.wrenModule.name, entity_type, entity_id } });

    // Fire on_submit workflows asynchronously — do not block response
    executeWorkflows(req.wrenModule, record, 'on_submit').catch(e => {
      console.error(`[workflows] on_submit error for module ${req.wrenModule.id}:`, e.message);
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id/records/:recordId
router.get('/:id/records/:recordId', loadModule, async (req, res) => {
  const portal = req.query.portal || process.env.WREN_EDITION || '';
  const isAdmin = ADMIN_ROLES.has(req.user.role);

  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT * FROM module_records WHERE id=$1 AND module_id=$2 AND is_deleted=false',
      [req.params.recordId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const record = rows[0];
    const isOwn = record.submitted_by === req.user.id;
    const canViewAll = isAdmin || canUserDo(req.wrenModule, req.user, 'view_all', portal);
    const canViewOwn = canUserDo(req.wrenModule, req.user, 'view_own', portal) && isOwn;
    if (!canViewAll && !canViewOwn) return res.status(403).json({ error: 'No view permission' });

    const { rows: uploads } = await db.query(
      'SELECT id, field_key, filename FROM module_uploads WHERE record_id=$1',
      [record.id]
    );
    record._uploads = uploads.map(u => ({ ...u, url: `/api/module-uploads/${u.id}` }));

    res.json(record);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id/records/:recordId
router.put('/:id/records/:recordId', loadModule, async (req, res) => {
  const portal = req.query.portal || process.env.WREN_EDITION || '';
  const isAdmin = ADMIN_ROLES.has(req.user.role);

  try {
    const db = getPool();
    const { rows: [existing] } = await db.query(
      'SELECT * FROM module_records WHERE id=$1 AND module_id=$2 AND is_deleted=false',
      [req.params.recordId, req.params.id]
    );
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const isOwn = existing.submitted_by === req.user.id;
    const canEditAll = isAdmin || canUserDo(req.wrenModule, req.user, 'edit_all', portal);
    const canEditOwn = canUserDo(req.wrenModule, req.user, 'edit_own', portal) && isOwn;
    if (!canEditAll && !canEditOwn) return res.status(403).json({ error: 'No edit permission' });

    const data = req.body.data !== undefined ? req.body.data : existing.data;
    const fields = req.wrenModule.fields || [];
    const errors = validateRecordData(fields, data);
    if (errors.length) return res.status(422).json({ errors });

    const { rows } = await db.query(
      'UPDATE module_records SET data=$1, updated_by=$2, updated_at=NOW() WHERE id=$3 RETURNING *',
      [JSON.stringify(data), req.user.id, req.params.recordId]
    );
    const diff = diffObjects(existing.data || {}, data);
    recordAudit({ req, action: 'update', entity_type: 'module_record', entity_id: req.params.recordId,
      diff, meta: { module_id: req.params.id, module_name: req.wrenModule.name } });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id/records/:recordId — soft-delete
router.delete('/:id/records/:recordId', loadModule, async (req, res) => {
  const portal = req.query.portal || process.env.WREN_EDITION || '';
  const isAdmin = ADMIN_ROLES.has(req.user.role);

  try {
    const db = getPool();
    const { rows: [existing] } = await db.query(
      'SELECT * FROM module_records WHERE id=$1 AND module_id=$2 AND is_deleted=false',
      [req.params.recordId, req.params.id]
    );
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const canDelete = isAdmin || canUserDo(req.wrenModule, req.user, 'delete', portal);
    if (!canDelete) return res.status(403).json({ error: 'No delete permission' });

    await db.query(
      'UPDATE module_records SET is_deleted=true, updated_by=$1, updated_at=NOW() WHERE id=$2',
      [req.user.id, req.params.recordId]
    );
    recordAudit({ req, action: 'delete', entity_type: 'module_record', entity_id: req.params.recordId,
      meta: { module_id: req.params.id, module_name: req.wrenModule.name } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Views ────────────────────────────────────────────────────────────────────

router.get('/:id/views', loadModule, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM module_views WHERE module_id=$1 ORDER BY name',
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/views', loadModule, async (req, res) => {
  const { name, description, filter_json = {}, sort = [], columns = [], display_type = 'table', display_config = {}, is_shared = false } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await getPool().query(`
      INSERT INTO module_views
        (module_id, name, description, filter_json, sort, columns, display_type, display_config, is_shared, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [req.params.id, name, description,
        JSON.stringify(filter_json), JSON.stringify(sort), JSON.stringify(columns),
        display_type, JSON.stringify(display_config),
        is_shared, req.user.id]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id/views/:viewId', loadModule, async (req, res) => {
  try {
    const allowed = ['name','description','filter_json','sort','columns','display_type','display_config','is_shared'];
    const updates = [];
    const vals = [];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        const v = typeof req.body[key] === 'object' && req.body[key] !== null
          ? JSON.stringify(req.body[key]) : req.body[key];
        vals.push(v);
        updates.push(`${key}=$${vals.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    vals.push(req.params.viewId, req.params.id);
    const { rows } = await getPool().query(
      `UPDATE module_views SET ${updates.join(',')} WHERE id=$${vals.length - 1} AND module_id=$${vals.length} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hard delete is OK for views (non-production data)
router.delete('/:id/views/:viewId', loadModule, requireAdmin, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'DELETE FROM module_views WHERE id=$1 AND module_id=$2 RETURNING id',
      [req.params.viewId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Workflows ────────────────────────────────────────────────────────────────

router.get('/:id/workflows', loadModule, requireAdmin, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM module_workflows WHERE module_id=$1 ORDER BY id',
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/workflows', loadModule, requireAdmin, async (req, res) => {
  const { name, trigger, schedule_cron, action_type, config = {}, is_active = true } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!trigger) return res.status(400).json({ error: 'trigger required' });
  if (!action_type) return res.status(400).json({ error: 'action_type required' });
  try {
    const { rows } = await getPool().query(`
      INSERT INTO module_workflows (module_id, name, trigger, schedule_cron, action_type, config, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `, [req.params.id, name, trigger, schedule_cron || null, action_type, JSON.stringify(config), is_active]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id/workflows/:wfId', loadModule, requireAdmin, async (req, res) => {
  try {
    const allowed = ['name','trigger','schedule_cron','action_type','config','is_active'];
    const updates = [];
    const vals = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        const v = typeof req.body[key] === 'object' && req.body[key] !== null
          ? JSON.stringify(req.body[key]) : req.body[key];
        vals.push(v);
        updates.push(`${key}=$${vals.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    vals.push(req.params.wfId, req.params.id);
    const { rows } = await getPool().query(
      `UPDATE module_workflows SET ${updates.join(',')} WHERE id=$${vals.length-1} AND module_id=$${vals.length} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/workflows/:wfId', loadModule, requireAdmin, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'DELETE FROM module_workflows WHERE id=$1 AND module_id=$2 RETURNING id',
      [req.params.wfId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Workflow execution engine ────────────────────────────────────────────────

async function executeWorkflows(mod, record, triggerType) {
  const db = getPool();
  const { rows: workflows } = await db.query(
    `SELECT * FROM module_workflows WHERE module_id=$1 AND trigger=$2 AND is_active=true`,
    [mod.id, triggerType]
  );
  for (const wf of workflows) {
    try {
      await runWorkflowAction(wf, mod, record, db);
    } catch (e) {
      console.error(`[workflow:${wf.id}:${wf.name}] failed:`, e.message);
    }
  }
}

async function runWorkflowAction(wf, mod, record, db) {
  const cfg = typeof wf.config === 'string' ? JSON.parse(wf.config) : (wf.config || {});
  const data = typeof record.data === 'string' ? JSON.parse(record.data) : (record.data || {});

  if (wf.action_type === 'ai_summary') {
    // Gate on feature flag
    const { rows: flags } = await db.query(
      `SELECT is_enabled FROM feature_flags WHERE key='ai_observation_writer'`
    );
    if (!flags.length || !flags[0].is_enabled) {
      console.log(`[workflow:${wf.id}] ai_summary skipped — feature flag off`);
      return;
    }

    const ollamaHost = process.env.OLLAMA_HOST || process.env.OLLAMA_URL || 'http://localhost:11434';
    const prompt = `Summarise this nursery record in 2-3 plain English sentences. Do not include names. Focus on what happened and what action was taken.\n\nRecord: ${JSON.stringify(data)}`;

    const summary = await callOllama(ollamaHost, 'qwen3.5:4b', prompt);
    if (summary) {
      await db.query(
        `UPDATE module_records SET ai_summary=$1 WHERE id=$2`,
        [summary, record.id]
      );
      console.log(`[workflow:${wf.id}] ai_summary saved for record ${record.id}`);
    }
    return;
  }

  if (wf.action_type === 'email') {
    const to = cfg.to_field ? (data[cfg.to_field] || cfg.to_address) : cfg.to_address;
    if (!to) { console.warn(`[workflow:${wf.id}] email: no recipient`); return; }

    const subject = cfg.subject || `New ${mod.name} record`;
    const body = cfg.body
      ? cfg.body.replace(/\{(\w+)\}/g, (_, k) => data[k] || '')
      : `A new ${mod.name} record was submitted.\n\n${JSON.stringify(data, null, 2)}`;

    if (!process.env.SMTP_HOST) {
      console.warn(`[workflow:${wf.id}] email: SMTP_HOST not configured`);
      return;
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text: body,
    });
    console.log(`[workflow:${wf.id}] email sent to ${to}`);
    return;
  }

  if (wf.action_type === 'create_record') {
    const targetModuleId = cfg.target_module_id;
    if (!targetModuleId) { console.warn(`[workflow:${wf.id}] create_record: no target_module_id`); return; }
    const newData = Object.assign({}, cfg.default_data || {});
    // Map fields from source record
    if (cfg.field_map) {
      for (const [srcKey, dstKey] of Object.entries(cfg.field_map)) {
        if (data[srcKey] !== undefined) newData[dstKey] = data[srcKey];
      }
    }
    await db.query(`
      INSERT INTO module_records (module_id, entity_type, entity_id, data, submitted_by, submitted_portal)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [targetModuleId, record.entity_type, record.entity_id,
        JSON.stringify(newData), record.submitted_by, record.submitted_portal]);
    console.log(`[workflow:${wf.id}] created record in module ${targetModuleId}`);
    return;
  }

  if (wf.action_type === 'webhook') {
    const webhookUrl = cfg.url;
    if (!webhookUrl) { console.warn(`[workflow:${wf.id}] webhook: no url`); return; }
    const payload = JSON.stringify({ record, module: { id: mod.id, name: mod.name, slug: mod.slug } });
    await postJson(webhookUrl, payload);
    console.log(`[workflow:${wf.id}] webhook posted to ${webhookUrl}`);
    return;
  }
}

function callOllama(baseUrl, model, prompt) {
  return new Promise((resolve) => {
    const url = new URL('/api/generate', baseUrl);
    const body = JSON.stringify({ model, prompt, stream: false, think: false });
    const lib = url.protocol === 'https:' ? https : require('http');
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res2) => {
      let data = '';
      res2.on('data', chunk => { data += chunk; });
      res2.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.response || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', (e) => { console.error('[ollama]', e.message); resolve(null); });
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

function postJson(urlStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : require('http');
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res2) => {
      res2.resume();
      res2.on('end', resolve);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('webhook timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── File uploads ─────────────────────────────────────────────────────────────

router.post('/:id/records/:recordId/uploads', loadModule, (req, res, next) => {
  fileUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 20MB)' });
      return res.status(err.status || 400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const db = getPool();
    const fieldKey = req.query.field_key || req.file.fieldname || 'file';

    const { rows } = await db.query(`
      INSERT INTO module_uploads
        (record_id, field_key, filename, mime_type, size_bytes, storage_path, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `, [req.params.recordId, fieldKey, req.file.originalname,
        req.file.mimetype, req.file.size, req.file.path, req.user.id]);

    res.status(201).json({ ...rows[0], url: `/api/module-uploads/${rows[0].id}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Uploads download handler (separate router, mounted at /api/module-uploads) ─

const uploadsHandler = express.Router();
uploadsHandler.use(authenticate);

uploadsHandler.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [upload] } = await db.query(`
      SELECT u.*, mr.module_id FROM module_uploads u
      JOIN module_records mr ON mr.id = u.record_id
      WHERE u.id=$1
    `, [req.params.id]);
    if (!upload) return res.status(404).json({ error: 'Not found' });

    const { rows: [mod] } = await db.query(
      'SELECT * FROM modules WHERE id=$1',
      [upload.module_id]
    );
    if (!mod) return res.status(404).json({ error: 'Module not found' });

    const portal = req.query.portal || process.env.WREN_EDITION || '';
    const isAdmin = ADMIN_ROLES.has(req.user.role);
    const canView = isAdmin
      || canUserDo(mod, req.user, 'view_all', portal)
      || canUserDo(mod, req.user, 'view_own', portal);
    if (!canView) return res.status(403).json({ error: 'Forbidden' });

    const resolved = path.resolve(upload.storage_path);
    if (!resolved.startsWith('/app/uploads/')) {
      return res.status(403).json({ error: 'Invalid file path' });
    }
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found on disk' });

    res.setHeader('Content-Type', upload.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${upload.filename}"`);
    res.sendFile(resolved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = router;
module.exports.uploadsHandler = uploadsHandler;
