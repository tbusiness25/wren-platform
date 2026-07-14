'use strict';
/**
 * Haven — role permission matrix + Express gate.
 *
 * Tiers (cumulative):
 *   basic_write    — carer and above: daily notes, body maps, handover,
 *                    reporting an incident.
 *   clinical_write — nurse / senior_carer and above: clinical scores,
 *                    care plans + reviews, risk assessments, CD register.
 *   senior_write   — manager / deputy_manager / nurse: safeguarding,
 *                    CQC notifications, MCA/DoLS.
 *   admin_write    — manager / deputy_manager: incident close/edit,
 *                    resident admin (admit / edit / discharge).
 *
 * Everyone logged in can READ everything (small home, shared care record).
 * Server-side is the source of truth; the UI matrix in public/js/haven.js
 * only hides buttons and must be kept in sync. Fail-closed: an unknown
 * role gets read-only.
 */

const MATRIX = {
  basic_write:    ['carer', 'nurse', 'senior_carer', 'manager', 'deputy_manager', 'admin'],
  clinical_write: ['nurse', 'senior_carer', 'manager', 'deputy_manager'],
  senior_write:   ['nurse', 'manager', 'deputy_manager'],
  admin_write:    ['manager', 'deputy_manager'],
};

function can(role, perm) {
  const allowed = MATRIX[perm];
  return !!allowed && allowed.includes(role);
}

// Express middleware factory — use AFTER authenticate (needs req.user.role)
function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
    if (!can(req.user.role, perm)) {
      const who = perm === 'admin_write' ? 'a manager'
        : perm === 'senior_write' ? 'a nurse or manager'
        : 'a nurse or senior carer';
      return res.status(403).json({
        error: `Your role does not have permission for this action — ask ${who} to do it.`,
      });
    }
    next();
  };
}

// Clean 500 handler — logs the real error, never leaks internals to the client.
function fail(res, e) {
  console.error('[haven]', e && e.stack ? e.stack.split('\n')[0] : e);
  res.status(500).json({ error: 'Something went wrong — please try again' });
}

module.exports = { MATRIX, can, requirePerm, fail };
