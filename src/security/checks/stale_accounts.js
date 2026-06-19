'use strict';
const { getPool } = require('../../db/pool');

const STALE_DAYS = 90;

module.exports = {
  key: 'stale_accounts',
  category: 'access',
  title: 'Stale staff accounts',
  description: `Lists staff accounts with no login activity in the past ${STALE_DAYS} days. Stale accounts belonging to former staff members are an access risk.`,
  async run() {
    const db = getPool();

    // CE scope: "stale" means a previously-active account that has gone dormant —
    // the risk being that it may belong to a leaver who retained access.
    // Accounts that have NEVER logged in are excluded: they represent current staff
    // pending onboarding, not a CE access-control risk. Leavers (contract_end in
    // the past) are still surfaced as FAIL regardless of login history.
    const { rows: stale } = await db.query(`
      SELECT id, first_name, last_name, role, last_login_at, contract_end
      FROM staff
      WHERE is_active = true
        AND (
          -- Former staff still active (leaver with retained access — CE risk)
          (contract_end IS NOT NULL AND contract_end < now())
          OR
          -- Previously active but dormant (logged in at some point, then went stale)
          (last_login_at IS NOT NULL AND last_login_at < now() - interval '${STALE_DAYS} days')
        )
      ORDER BY last_login_at ASC NULLS FIRST
      LIMIT 50
    `);

    const { rows: [{ total }] } = await db.query(`SELECT count(*) AS total FROM staff WHERE is_active = true`);

    if (stale.length === 0) {
      return {
        status: 'pass',
        finding: `All ${total} active staff accounts have logged in within the past ${STALE_DAYS} days.`,
        remediation: null,
        evidence: { total_active: parseInt(total), stale_count: 0 },
      };
    }

    const leavers = stale.filter(s => s.contract_end && new Date(s.contract_end) < new Date());
    const neverLoggedIn = stale.filter(s => !s.last_login_at);

    const names = stale.slice(0, 10).map(s =>
      `${s.first_name} ${s.last_name} (${s.role}${s.last_login_at ? ', last: ' + new Date(s.last_login_at).toLocaleDateString('en-GB') : ', never logged in'}${s.contract_end ? ', contract ended' : ''})`
    ).join('; ');

    const severity = leavers.length > 0 ? 'fail' : 'warn';

    return {
      status: severity,
      finding: `${stale.length} active staff account(s) have not logged in for over ${STALE_DAYS} days.${leavers.length > 0 ? ` ${leavers.length} of these have a past contract end date — their accounts should be deactivated.` : ''} Accounts: ${names}${stale.length > 10 ? ` and ${stale.length - 10} more` : ''}.`,
      remediation: 'Review these accounts. Deactivate any accounts belonging to staff who have left: UPDATE ladn.staff SET is_active=false WHERE id=X. Accounts that have simply not logged in recently should be verified with the staff member.',
      evidence: { stale_accounts: stale, total_active: parseInt(total) },
    };
  },
};
