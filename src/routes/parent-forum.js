'use strict';
// Parent Community / Forum (2026-07-28) — DEV BUILD, not yet mounted in
// server-unified.js (see NOTES: /app/ladn-ready/logs/parent-forum.NOTES.md).
//
// Toby's brief: auto groups per room (Baby Room / Pre-school, derived from
// children.room_id), parent-created groups anyone can join, NEVER anonymous
// (every post carries the poster's real name), fully auditable (every
// create/edit/delete/hide/remove is logged), managers can moderate from Roost.
//
// This is group discussion, not 1:1 DM — it deliberately does NOT touch
// message_threads/messages (those stay as-is). It reuses the same
// conventions those routes use: parent identity = email (not a stable
// parent_portal_access id — the canonical parent JWT from /api/auth/
// cf-auto-login always carries id:0), audit rows shaped like message_audit
// (action/actor_type/detail), schema self-creates idempotently so this
// deploys with no separate migration step (ALTER/CREATE ... IF NOT EXISTS
// only — never DROP/TRUNCATE, per CLAUDE.md rule 4).
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');

const managerOnly = requireRole('manager', 'deputy_manager');

// ── Schema (additive, idempotent) ─────────────────────────────────────────────
let _schemaReady = false;
async function ensureSchema(db) {
  if (_schemaReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS parent_groups (
      id                 serial PRIMARY KEY,
      slug               text UNIQUE,
      name               text NOT NULL,
      description        text,
      kind               text NOT NULL DEFAULT 'custom' CHECK (kind IN ('room','custom')),
      room_id            integer REFERENCES rooms(id),
      created_by_email   text,
      created_by_staff_id integer REFERENCES staff(id),
      is_active          boolean NOT NULL DEFAULT true,
      created_at         timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS parent_groups_room_uq
      ON parent_groups(room_id) WHERE kind='room' AND room_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS parent_group_members (
      id                  serial PRIMARY KEY,
      group_id            integer NOT NULL REFERENCES parent_groups(id) ON DELETE CASCADE,
      parent_email        text NOT NULL,
      child_id            integer REFERENCES children(id),
      role                text NOT NULL DEFAULT 'member' CHECK (role IN ('member','creator')),
      joined_at           timestamptz NOT NULL DEFAULT now(),
      left_at             timestamptz,
      removed_by_staff_id integer REFERENCES staff(id),
      removed_at          timestamptz,
      removed_reason      text,
      UNIQUE(group_id, parent_email)
    );
    CREATE INDEX IF NOT EXISTS parent_group_members_email_idx ON parent_group_members(lower(parent_email));

    CREATE TABLE IF NOT EXISTS parent_group_posts (
      id                  serial PRIMARY KEY,
      group_id            integer NOT NULL REFERENCES parent_groups(id) ON DELETE CASCADE,
      parent_email        text NOT NULL,
      author_name         text NOT NULL,
      reply_to_id         integer REFERENCES parent_group_posts(id) ON DELETE CASCADE,
      body                text NOT NULL,
      created_at          timestamptz NOT NULL DEFAULT now(),
      edited_at           timestamptz,
      hidden_by_staff_id  integer REFERENCES staff(id),
      hidden_at           timestamptz,
      hidden_reason       text,
      deleted_at          timestamptz
    );
    CREATE INDEX IF NOT EXISTS parent_group_posts_group_idx ON parent_group_posts(group_id, created_at);
    CREATE INDEX IF NOT EXISTS parent_group_posts_reply_idx ON parent_group_posts(reply_to_id);

    CREATE TABLE IF NOT EXISTS parent_group_post_audit (
      id             serial PRIMARY KEY,
      group_id       integer,
      post_id        integer,
      action         text NOT NULL,
      actor_type     text NOT NULL CHECK (actor_type IN ('parent','staff')),
      actor_email    text,
      actor_staff_id integer REFERENCES staff(id),
      actor_name     text,
      detail         text,
      created_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS parent_group_post_audit_group_idx ON parent_group_post_audit(group_id, created_at);
  `);

  // Seed the two room-based groups (idempotent — ON CONFLICT on the partial
  // unique index above). Room ids are looked up by name rather than hard-coded
  // (verified 1/'Baby Room', 2/'Pre-school' in both wren_dev and prod, but this
  // keeps the seed correct even if that ever changes).
  await db.query(`
    INSERT INTO parent_groups (slug, name, description, kind, room_id)
    SELECT 'room-baby-room', 'Baby Room Parents', 'For parents of children in the Baby Room (6m–2yr).', 'room', r.id
    FROM rooms r WHERE r.name='Baby Room'
    ON CONFLICT (slug) DO NOTHING;
    INSERT INTO parent_groups (slug, name, description, kind, room_id)
    SELECT 'room-pre-school', 'Pre-school Parents', 'For parents of children in Pre-school (2–5yr).', 'room', r.id
    FROM rooms r WHERE r.name='Pre-school'
    ON CONFLICT (slug) DO NOTHING;
  `);

  _schemaReady = true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function logAudit(db, { groupId = null, postId = null, action, actorType, actorEmail = null, actorStaffId = null, actorName = null, detail = null }) {
  try {
    await db.query(
      `INSERT INTO parent_group_post_audit (group_id, post_id, action, actor_type, actor_email, actor_staff_id, actor_name, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [groupId, postId, action, actorType, actorEmail, actorStaffId, actorName, detail ? String(detail).slice(0, 500) : null]
    );
  } catch (e) { console.error('[parent-forum] audit write failed:', e.message); }
}

// Resolve a parent's real display name from the children table (parent_1/2
// name+email), matched against any of their linked children — same pattern
// used across messages.js / newsletter.js / permission-slips.js.
async function resolveParentName(db, email, childIds) {
  if (!email) return 'Parent';
  try {
    const { rows } = await db.query(
      `SELECT parent_1_name, parent_1_email, parent_2_name, parent_2_email
       FROM children WHERE id = ANY($1)`,
      [childIds && childIds.length ? childIds : [-1]]
    );
    for (const c of rows) {
      if (c.parent_1_email && c.parent_1_email.toLowerCase() === email.toLowerCase() && c.parent_1_name) return c.parent_1_name;
      if (c.parent_2_email && c.parent_2_email.toLowerCase() === email.toLowerCase() && c.parent_2_name) return c.parent_2_name;
    }
  } catch (e) { console.error('[parent-forum] resolveParentName failed:', e.message); }
  return 'Parent';
}

// Ensure this parent has a membership row in the room group(s) matching
// their children's current room(s). Additive-only — never removes a parent
// from a group they already belong to (e.g. after a room change), so
// history stays intact; a manager can remove them via the moderation panel
// if needed.
async function ensureRoomMembership(db, email, childIds) {
  if (!email || !childIds || !childIds.length) return;
  try {
    const { rows: kids } = await db.query(
      `SELECT id, room_id FROM children WHERE id = ANY($1) AND room_id IS NOT NULL`,
      [childIds]
    );
    const roomIds = [...new Set(kids.map(k => k.room_id))];
    if (!roomIds.length) return;
    const { rows: groups } = await db.query(
      `SELECT id, room_id FROM parent_groups WHERE kind='room' AND room_id = ANY($1) AND is_active=true`,
      [roomIds]
    );
    for (const g of groups) {
      const kid = kids.find(k => k.room_id === g.room_id);
      await db.query(
        `INSERT INTO parent_group_members (group_id, parent_email, child_id, role)
         VALUES ($1,$2,$3,'member')
         ON CONFLICT (group_id, parent_email) DO NOTHING`,
        [g.id, email.toLowerCase(), kid ? kid.id : null]
      );
    }
  } catch (e) { console.error('[parent-forum] ensureRoomMembership failed:', e.message); }
}

async function isMember(db, groupId, email) {
  const { rows } = await db.query(
    `SELECT 1 FROM parent_group_members WHERE group_id=$1 AND lower(parent_email)=lower($2) AND left_at IS NULL AND removed_at IS NULL`,
    [groupId, email]
  );
  return rows.length > 0;
}

function slugify(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'group';
}

// ── Parent auth (matches the canonical parent JWT minted by
//    /api/auth/cf-auto-login — role:'parent', child_id, child_ids, aud
//    scoped per-portal via Host-header dispatch in server-unified.js) ─────────
function parentAuth(req, res, next) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-wren-token'] || '');
  if (!token) return res.status(401).json({ error: 'Unauthorised' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const expectedAud = req._portal || 'parents';
    if (!decoded.aud || decoded.aud !== expectedAud) {
      return res.status(401).json({ error: 'Invalid token audience' });
    }
    if (decoded.role !== 'parent') return res.status(403).json({ error: 'Parent account required' });
    req.parent = decoded;
    req.parentEmail = (decoded.name || decoded.email || '').toLowerCase().trim();
    req.childIds = (decoded.child_ids && decoded.child_ids.length) ? decoded.child_ids
                  : (decoded.child_id != null ? [decoded.child_id] : []);
    if (!req.parentEmail) return res.status(401).json({ error: 'Unauthorised' });
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// ═══════════════════════════════════════════════════════════════════════════
// PARENT ENDPOINTS — /api/parent-forum/*
// ═══════════════════════════════════════════════════════════════════════════

// GET /groups — groups this parent belongs to (auto room groups + joined custom)
router.get('/groups', parentAuth, async (req, res) => {
  const db = getPool();
  try {
    await ensureSchema(db);
    await ensureRoomMembership(db, req.parentEmail, req.childIds);
    const { rows } = await db.query(
      `SELECT g.id, g.slug, g.name, g.description, g.kind, g.room_id, m.role, m.joined_at,
              (SELECT count(*)::int FROM parent_group_members m2 WHERE m2.group_id=g.id AND m2.left_at IS NULL AND m2.removed_at IS NULL) AS member_count,
              (SELECT count(*)::int FROM parent_group_posts p WHERE p.group_id=g.id AND p.deleted_at IS NULL AND p.hidden_at IS NULL) AS post_count,
              (SELECT max(p.created_at) FROM parent_group_posts p WHERE p.group_id=g.id AND p.deleted_at IS NULL AND p.hidden_at IS NULL) AS last_post_at
       FROM parent_group_members m
       JOIN parent_groups g ON g.id = m.group_id AND g.is_active=true
       WHERE lower(m.parent_email)=$1 AND m.left_at IS NULL AND m.removed_at IS NULL
       ORDER BY g.kind='room' DESC, last_post_at DESC NULLS LAST, g.name`,
      [req.parentEmail]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /discover — active custom groups this parent hasn't joined yet
router.get('/discover', parentAuth, async (req, res) => {
  const db = getPool();
  try {
    await ensureSchema(db);
    const { rows } = await db.query(
      `SELECT g.id, g.slug, g.name, g.description, g.created_at,
              (SELECT count(*)::int FROM parent_group_members m2 WHERE m2.group_id=g.id AND m2.left_at IS NULL AND m2.removed_at IS NULL) AS member_count
       FROM parent_groups g
       WHERE g.kind='custom' AND g.is_active=true
         AND NOT EXISTS (SELECT 1 FROM parent_group_members m WHERE m.group_id=g.id AND lower(m.parent_email)=$1 AND m.left_at IS NULL AND m.removed_at IS NULL)
       ORDER BY g.created_at DESC`,
      [req.parentEmail]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /groups — create a custom group (any parent)
router.post('/groups', parentAuth, async (req, res) => {
  const db = getPool();
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  if (name.length > 100) return res.status(400).json({ error: 'name too long (max 100)' });
  try {
    await ensureSchema(db);
    let slug = slugify(name), attempt = 0, finalSlug = slug;
    // Avoid slug collisions with a numeric suffix.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { rows: clash } = await db.query('SELECT 1 FROM parent_groups WHERE slug=$1', [finalSlug]);
      if (!clash.length) break;
      attempt += 1; finalSlug = `${slug}-${attempt}`;
      if (attempt > 50) return res.status(409).json({ error: 'Could not allocate a unique group name — try a different name.' });
    }
    const authorName = await resolveParentName(db, req.parentEmail, req.childIds);
    const { rows } = await db.query(
      `INSERT INTO parent_groups (slug, name, description, kind, created_by_email)
       VALUES ($1,$2,$3,'custom',$4) RETURNING id, slug, name, description, kind, created_at`,
      [finalSlug, name, description || null, req.parentEmail]
    );
    const group = rows[0];
    await db.query(
      `INSERT INTO parent_group_members (group_id, parent_email, role) VALUES ($1,$2,'creator')`,
      [group.id, req.parentEmail]
    );
    await logAudit(db, { groupId: group.id, action: 'create_group', actorType: 'parent', actorEmail: req.parentEmail, actorName: authorName, detail: name });
    res.status(201).json(group);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /groups/:id/join — join a custom group
router.post('/groups/:id/join', parentAuth, async (req, res) => {
  const db = getPool();
  const groupId = parseInt(req.params.id, 10);
  try {
    await ensureSchema(db);
    const { rows: g } = await db.query('SELECT * FROM parent_groups WHERE id=$1 AND is_active=true', [groupId]);
    if (!g.length) return res.status(404).json({ error: 'Group not found' });
    if (g[0].kind !== 'custom') return res.status(400).json({ error: 'Room groups are automatic — nothing to join' });
    const authorName = await resolveParentName(db, req.parentEmail, req.childIds);
    await db.query(
      `INSERT INTO parent_group_members (group_id, parent_email, role) VALUES ($1,$2,'member')
       ON CONFLICT (group_id, parent_email) DO UPDATE SET left_at=NULL, removed_at=NULL, removed_by_staff_id=NULL, removed_reason=NULL`,
      [groupId, req.parentEmail]
    );
    await logAudit(db, { groupId, action: 'join_group', actorType: 'parent', actorEmail: req.parentEmail, actorName: authorName, detail: g[0].name });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /groups/:id/leave — leave a custom group (room groups cannot be left)
router.post('/groups/:id/leave', parentAuth, async (req, res) => {
  const db = getPool();
  const groupId = parseInt(req.params.id, 10);
  try {
    await ensureSchema(db);
    const { rows: g } = await db.query('SELECT * FROM parent_groups WHERE id=$1', [groupId]);
    if (!g.length) return res.status(404).json({ error: 'Group not found' });
    if (g[0].kind !== 'custom') return res.status(400).json({ error: 'You cannot leave your room group' });
    const authorName = await resolveParentName(db, req.parentEmail, req.childIds);
    await db.query(
      `UPDATE parent_group_members SET left_at=now() WHERE group_id=$1 AND lower(parent_email)=$2 AND left_at IS NULL`,
      [groupId, req.parentEmail]
    );
    await logAudit(db, { groupId, action: 'leave_group', actorType: 'parent', actorEmail: req.parentEmail, actorName: authorName, detail: g[0].name });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /groups/:id/feed — top-level posts (paginated)
router.get('/groups/:id/feed', parentAuth, async (req, res) => {
  const db = getPool();
  const groupId = parseInt(req.params.id, 10);
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const before = req.query.before || null;
  try {
    await ensureSchema(db);
    if (!(await isMember(db, groupId, req.parentEmail))) return res.status(403).json({ error: 'Not a member of this group' });
    const { rows } = await db.query(
      `SELECT p.id, p.parent_email, p.author_name, p.body, p.created_at, p.edited_at,
              (p.hidden_at IS NOT NULL) AS hidden,
              (lower(p.parent_email)=$2) AS is_mine,
              (SELECT count(*)::int FROM parent_group_posts r WHERE r.reply_to_id=p.id AND r.deleted_at IS NULL AND r.hidden_at IS NULL) AS reply_count
       FROM parent_group_posts p
       WHERE p.group_id=$1 AND p.reply_to_id IS NULL AND p.deleted_at IS NULL AND p.hidden_at IS NULL
         AND ($3::timestamptz IS NULL OR p.created_at < $3)
       ORDER BY p.created_at DESC
       LIMIT $4`,
      [groupId, req.parentEmail, before, limit]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /posts/:id/replies
router.get('/posts/:id/replies', parentAuth, async (req, res) => {
  const db = getPool();
  const postId = parseInt(req.params.id, 10);
  try {
    await ensureSchema(db);
    const { rows: pRows } = await db.query('SELECT group_id FROM parent_group_posts WHERE id=$1', [postId]);
    if (!pRows.length) return res.status(404).json({ error: 'Post not found' });
    if (!(await isMember(db, pRows[0].group_id, req.parentEmail))) return res.status(403).json({ error: 'Not a member of this group' });
    const { rows } = await db.query(
      `SELECT id, parent_email, author_name, body, created_at, edited_at, (hidden_at IS NOT NULL) AS hidden,
              (lower(parent_email)=$2) AS is_mine
       FROM parent_group_posts
       WHERE reply_to_id=$1 AND deleted_at IS NULL AND hidden_at IS NULL
       ORDER BY created_at ASC`,
      [postId, req.parentEmail]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /groups/:id/posts — create a post or reply
router.post('/groups/:id/posts', parentAuth, async (req, res) => {
  const db = getPool();
  const groupId = parseInt(req.params.id, 10);
  const body = (req.body.body || '').trim();
  const replyToId = req.body.reply_to_id ? parseInt(req.body.reply_to_id, 10) : null;
  if (!body) return res.status(400).json({ error: 'body required' });
  if (body.length > 4000) return res.status(400).json({ error: 'Post too long (max 4000 chars)' });
  try {
    await ensureSchema(db);
    if (!(await isMember(db, groupId, req.parentEmail))) return res.status(403).json({ error: 'Not a member of this group' });
    if (replyToId) {
      const { rows: parent } = await db.query('SELECT group_id FROM parent_group_posts WHERE id=$1 AND deleted_at IS NULL', [replyToId]);
      if (!parent.length || parent[0].group_id !== groupId) return res.status(400).json({ error: 'Invalid reply_to_id' });
    }
    const authorName = await resolveParentName(db, req.parentEmail, req.childIds);
    const { rows } = await db.query(
      `INSERT INTO parent_group_posts (group_id, parent_email, author_name, reply_to_id, body)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, group_id, parent_email, author_name, body, created_at, reply_to_id`,
      [groupId, req.parentEmail, authorName, replyToId, body]
    );
    const post = rows[0];
    await logAudit(db, { groupId, postId: post.id, action: replyToId ? 'reply_create' : 'post_create', actorType: 'parent', actorEmail: req.parentEmail, actorName: authorName, detail: body });
    res.status(201).json(post);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /posts/:id — edit own post
router.put('/posts/:id', parentAuth, async (req, res) => {
  const db = getPool();
  const postId = parseInt(req.params.id, 10);
  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'body required' });
  if (body.length > 4000) return res.status(400).json({ error: 'Post too long (max 4000 chars)' });
  try {
    await ensureSchema(db);
    const { rows } = await db.query('SELECT * FROM parent_group_posts WHERE id=$1 AND deleted_at IS NULL', [postId]);
    if (!rows.length) return res.status(404).json({ error: 'Post not found' });
    const post = rows[0];
    if (post.parent_email.toLowerCase() !== req.parentEmail) return res.status(403).json({ error: 'You can only edit your own posts' });
    if (post.hidden_at) return res.status(403).json({ error: 'This post has been hidden by a manager and cannot be edited' });
    await db.query('UPDATE parent_group_posts SET body=$1, edited_at=now() WHERE id=$2', [body, postId]);
    await logAudit(db, { groupId: post.group_id, postId, action: 'post_edit', actorType: 'parent', actorEmail: req.parentEmail, actorName: post.author_name, detail: body });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /posts/:id — soft-delete own post
router.delete('/posts/:id', parentAuth, async (req, res) => {
  const db = getPool();
  const postId = parseInt(req.params.id, 10);
  try {
    await ensureSchema(db);
    const { rows } = await db.query('SELECT * FROM parent_group_posts WHERE id=$1 AND deleted_at IS NULL', [postId]);
    if (!rows.length) return res.status(404).json({ error: 'Post not found' });
    const post = rows[0];
    if (post.parent_email.toLowerCase() !== req.parentEmail) return res.status(403).json({ error: 'You can only delete your own posts' });
    await db.query('UPDATE parent_group_posts SET deleted_at=now() WHERE id=$1', [postId]);
    await logAudit(db, { groupId: post.group_id, postId, action: 'post_delete_own', actorType: 'parent', actorEmail: req.parentEmail, actorName: post.author_name, detail: post.body });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// MANAGER ENDPOINTS (Roost) — /api/parent-forum/admin/*
// ═══════════════════════════════════════════════════════════════════════════

// GET /admin/groups — all groups
router.get('/admin/groups', authenticate, managerOnly, async (req, res) => {
  const db = getPool();
  try {
    await ensureSchema(db);
    const { rows } = await db.query(
      `SELECT g.id, g.slug, g.name, g.description, g.kind, g.room_id, g.created_by_email, g.created_at, g.is_active,
              (SELECT count(*)::int FROM parent_group_members m WHERE m.group_id=g.id AND m.left_at IS NULL AND m.removed_at IS NULL) AS member_count,
              (SELECT count(*)::int FROM parent_group_posts p WHERE p.group_id=g.id AND p.deleted_at IS NULL) AS post_count,
              (SELECT count(*)::int FROM parent_group_posts p WHERE p.group_id=g.id AND p.hidden_at IS NOT NULL) AS hidden_count
       FROM parent_groups g
       ORDER BY g.kind='room' DESC, g.created_at DESC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /admin/groups/:id/members
router.get('/admin/groups/:id/members', authenticate, managerOnly, async (req, res) => {
  const db = getPool();
  const groupId = parseInt(req.params.id, 10);
  try {
    await ensureSchema(db);
    const { rows } = await db.query(
      `SELECT m.id, m.parent_email, m.role, m.joined_at, m.left_at, m.removed_at, m.removed_reason,
              c.first_name AS child_first_name, c.last_name AS child_last_name
       FROM parent_group_members m
       LEFT JOIN children c ON c.id = m.child_id
       WHERE m.group_id=$1
       ORDER BY m.left_at IS NOT NULL, m.removed_at IS NOT NULL, m.joined_at`,
      [groupId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /admin/members/:id — remove a member from a group
router.delete('/admin/members/:id', authenticate, managerOnly, async (req, res) => {
  const db = getPool();
  const memberId = parseInt(req.params.id, 10);
  const reason = (req.body.reason || '').trim() || null;
  try {
    await ensureSchema(db);
    const { rows } = await db.query('SELECT * FROM parent_group_members WHERE id=$1', [memberId]);
    if (!rows.length) return res.status(404).json({ error: 'Member not found' });
    const m = rows[0];
    await db.query(
      `UPDATE parent_group_members SET removed_at=now(), removed_by_staff_id=$1, removed_reason=$2 WHERE id=$3`,
      [req.user.id, reason, memberId]
    );
    await logAudit(db, {
      groupId: m.group_id, action: 'remove_member', actorType: 'staff', actorStaffId: req.user.id,
      actorName: req.user.name, detail: `${m.parent_email}${reason ? ' — ' + reason : ''}`,
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /admin/groups/:id/feed — full feed incl. hidden posts, flat with reply nesting hint
router.get('/admin/groups/:id/feed', authenticate, managerOnly, async (req, res) => {
  const db = getPool();
  const groupId = parseInt(req.params.id, 10);
  try {
    await ensureSchema(db);
    const { rows } = await db.query(
      `SELECT p.id, p.parent_email, p.author_name, p.body, p.created_at, p.edited_at, p.reply_to_id,
              p.deleted_at, p.hidden_at, p.hidden_reason,
              s.first_name AS hidden_by_first_name, s.last_name AS hidden_by_last_name
       FROM parent_group_posts p
       LEFT JOIN staff s ON s.id = p.hidden_by_staff_id
       WHERE p.group_id=$1
       ORDER BY p.created_at DESC
       LIMIT 300`,
      [groupId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /admin/posts/:id/hide
router.post('/admin/posts/:id/hide', authenticate, managerOnly, async (req, res) => {
  const db = getPool();
  const postId = parseInt(req.params.id, 10);
  const reason = (req.body.reason || '').trim() || null;
  try {
    await ensureSchema(db);
    const { rows } = await db.query('SELECT * FROM parent_group_posts WHERE id=$1', [postId]);
    if (!rows.length) return res.status(404).json({ error: 'Post not found' });
    const post = rows[0];
    await db.query(
      `UPDATE parent_group_posts SET hidden_by_staff_id=$1, hidden_at=now(), hidden_reason=$2 WHERE id=$3`,
      [req.user.id, reason, postId]
    );
    await logAudit(db, {
      groupId: post.group_id, postId, action: 'post_hide', actorType: 'staff', actorStaffId: req.user.id,
      actorName: req.user.name, detail: reason || post.body,
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /admin/posts/:id/unhide
router.post('/admin/posts/:id/unhide', authenticate, managerOnly, async (req, res) => {
  const db = getPool();
  const postId = parseInt(req.params.id, 10);
  try {
    await ensureSchema(db);
    const { rows } = await db.query('SELECT * FROM parent_group_posts WHERE id=$1', [postId]);
    if (!rows.length) return res.status(404).json({ error: 'Post not found' });
    const post = rows[0];
    await db.query(
      `UPDATE parent_group_posts SET hidden_by_staff_id=NULL, hidden_at=NULL, hidden_reason=NULL WHERE id=$1`,
      [postId]
    );
    await logAudit(db, {
      groupId: post.group_id, postId, action: 'post_unhide', actorType: 'staff', actorStaffId: req.user.id, actorName: req.user.name,
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /admin/audit — audit log, optional ?group_id=
router.get('/admin/audit', authenticate, managerOnly, async (req, res) => {
  const db = getPool();
  const groupId = req.query.group_id ? parseInt(req.query.group_id, 10) : null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  try {
    await ensureSchema(db);
    const { rows } = await db.query(
      `SELECT a.id, a.group_id, g.name AS group_name, a.post_id, a.action, a.actor_type, a.actor_email,
              a.actor_staff_id, a.actor_name, a.detail, a.created_at
       FROM parent_group_post_audit a
       LEFT JOIN parent_groups g ON g.id = a.group_id
       WHERE ($1::int IS NULL OR a.group_id=$1)
       ORDER BY a.created_at DESC
       LIMIT $2`,
      [groupId, limit]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
