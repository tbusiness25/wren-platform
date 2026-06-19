'use strict';
const { getPool } = require('../db/pool');

/**
 * recordAudit — fire-and-forget audit entry. Never throws; failures are logged to stderr.
 *
 * @param {object} opts
 * @param {object} opts.req          — Express request (provides user, ip, user_agent)
 * @param {string} opts.action       — create | update | delete | view | export | login | logout
 * @param {string} opts.entity_type  — child | staff | module_record | observation | etc.
 * @param {string|number} [opts.entity_id]
 * @param {object} [opts.diff]       — { old: {...}, new: {...} } (trimmed to changed keys only)
 * @param {object} [opts.meta]       — arbitrary extra data
 * @param {string} [opts.actor_type] — override actor_type (default: derived from req.user)
 * @param {string} [opts.actor_email]— override actor_email (for parent actors)
 * @param {number} [opts.actor_id]  — override actor_id (used at login before req.user is set)
 */
async function recordAudit({ req, action, entity_type, entity_id, diff, meta, actor_type, actor_email, actor_id }) {
  try {
    const db = getPool();
    const user = req && req.user;

    const aType = actor_type || (user ? (user.role === 'parent' ? 'parent' : 'staff') : 'anonymous');
    const aId   = actor_id !== undefined ? actor_id
      : (user && user.role !== 'parent') ? (user.id || null) : null;
    const aEmail = actor_email || (user && user.role === 'parent' ? user.name : null);

    const edition = req ? (req.app.get('wren_edition') || process.env.WREN_EDITION || null) : null;

    const ip = req ? (
      req.headers['cf-connecting-ip'] ||
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.ip ||
      null
    ) : null;

    const ua = req ? (req.headers['user-agent'] || null) : null;

    await db.query(
      `INSERT INTO ladn.audit_log
         (actor_type, actor_id, actor_email, action, entity_type, entity_id,
          edition, ip, user_agent, diff, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        aType,
        aId,
        aEmail,
        action,
        entity_type,
        entity_id !== undefined && entity_id !== null ? String(entity_id) : null,
        edition,
        ip,
        ua,
        diff ? JSON.stringify(diff) : null,
        meta ? JSON.stringify(meta) : null,
      ]
    );
  } catch (err) {
    // Never surface audit failures to callers
    console.error('[audit] write failed:', err.message);
  }
}

/**
 * diffObjects — return only the keys that changed between oldObj and newObj.
 * Returns { old: {changedKeys…}, new: {changedKeys…} }
 */
function diffObjects(oldObj, newObj) {
  if (!oldObj || !newObj) return null;
  const changed = Object.keys(newObj).filter(k => {
    const a = JSON.stringify(oldObj[k]);
    const b = JSON.stringify(newObj[k]);
    return a !== b;
  });
  if (!changed.length) return null;
  const old_ = {};
  const new_ = {};
  for (const k of changed) {
    old_[k] = oldObj[k];
    new_[k] = newObj[k];
  }
  return { old: old_, new: new_ };
}

module.exports = { recordAudit, diffObjects };
