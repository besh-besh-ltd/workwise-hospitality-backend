// ============================================================================
// dashboardConfigModel.js
// ----------------------------------------------------------------------------
// Per-buyer-company settings for the buyer dashboard (SPEC decision D5).
//
// `tbl_company.buyer_dashboard_v3` is the runtime rollout switch for the
// role-aware dashboard: read by GET /dashboard-v2/config (which layout the
// frontend renders) and by the widget guard (whether widget grants apply).
// ============================================================================

import db from '../../config/dbConn.js';

// Postgres "undefined_column". Application deploys can land before their
// migrations are applied; until 20260928101000 runs, every company is off.
const UNDEFINED_COLUMN = '42703';

/** Is the role-aware dashboard switched on for this buyer company? */
export async function isV3Enabled(buyerCompanyId) {
  if (!buyerCompanyId) return false;
  try {
    const row = await db.oneOrNone(
      `SELECT buyer_dashboard_v3 FROM tbl_company WHERE id = $1`,
      [buyerCompanyId]
    );
    return row?.buyer_dashboard_v3 === true;
  } catch (err) {
    if (err?.code === UNDEFINED_COLUMN) return false;
    throw err;
  }
}

/**
 * Email of an active administrator of this buyer company, for the
 * "no widgets assigned — contact your administrator" state. Prefers a holder
 * of the company.admin capability in one of the company's hospitality
 * entities; falls back to a legacy admin (user_type 7) of the same company.
 * Returns null when there is none — the frontend then hides the link.
 */
export async function getAdminContactEmail(buyerCompanyId) {
  if (!buyerCompanyId) return null;
  const row = await db.oneOrNone(
    `SELECT u.email
       FROM tbl_users u
      WHERE u.status = 1
        AND NULLIF(TRIM(u.email), '') IS NOT NULL
        AND (
          EXISTS (
            SELECT 1
              FROM tbl_user_role_scopes urs
              JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
              JOIN tbl_permissions p ON p.id = rp.permission_id
              JOIN tbl_hospitality_companies hc ON hc.id = urs.company_id
             WHERE urs.user_id = u.id
               AND p.resource::text = 'company'
               AND p.action::text = 'admin'
               AND hc.buyer_company_id = $1
          )
          OR (u.user_type = 7 AND u.company_id = $1)
        )
      ORDER BY (u.user_type = 7), u.id
      LIMIT 1`,
    [buyerCompanyId]
  );
  return row?.email || null;
}

export default { isV3Enabled, getAdminContactEmail };
