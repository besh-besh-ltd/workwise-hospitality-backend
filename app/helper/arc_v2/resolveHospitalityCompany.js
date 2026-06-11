import db from '../../config/dbConn.js';

/**
 * Resolve the buyer-side hospitality_company_id for an Express request.
 *
 * Priority:
 *   1. Explicit query param  hospitality_company_id (caller override)
 *   2. X-Hospitality-Company / X-Hospitality-Company-Id header
 *      (injected by frontend/lib/axios.js once the user has picked a BU)
 *   3. req.user.hospitality_company_id (legacy; rarely populated on the
 *      JWT payload but kept for safety)
 *   4. Fallback: first row in tbl_hospitality_user_mappings for this user
 *      (covers the case where a buyer has access to exactly one hospitality
 *      company and the FE hasn't surfaced the BU picker yet)
 *
 * Returns a positive integer, or null if nothing resolved.
 */
export async function resolveHospitalityCompanyId(req) {
  const explicit =
    req.query?.hospitality_company_id ||
    req.headers?.['x-hospitality-company'] ||
    req.headers?.['x-hospitality-company-id'] ||
    req.user?.hospitality_company_id;

  if (explicit) {
    const n = Number(explicit);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  if (req.user?.id) {
    const row = await db.oneOrNone(
      `SELECT hospitality_company_id
         FROM tbl_hospitality_user_mappings
        WHERE user_id = $1
          AND hospitality_company_id IS NOT NULL
        ORDER BY id
        LIMIT 1`,
      [req.user.id]
    );
    if (row?.hospitality_company_id) return Number(row.hospitality_company_id);
  }

  return null;
}
