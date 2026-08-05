import db from '../../config/dbConn.js';

/**
 * Resolve the buyer-side hospitality_company_id for an Express request — WITHOUT
 * trusting the client to widen scope (audit H7).
 *
 * A client may *hint* a company via the query param or the
 * X-Hospitality-Company(-Id) header (the FE sends the user's selected BU), but
 * the hint is honored ONLY if the user is actually mapped to that company.
 * Otherwise it's refused (returns null → callers answer 400). With no hint, we
 * fall back to the user's first mapped company. Super admins (user_type 8) may
 * act on any company.
 *
 * Returns a positive integer, or null if nothing valid resolved.
 */
export async function resolveHospitalityCompanyId(req) {
  const raw =
    req.query?.hospitality_company_id ||
    req.headers?.['x-hospitality-company'] ||
    req.headers?.['x-hospitality-company-id'] ||
    req.user?.hospitality_company_id;
  const hinted = (raw != null && Number.isFinite(Number(raw)) && Number(raw) > 0)
    ? Number(raw)
    : null;

  // Super admin may operate on any company.
  if (Number(req.user?.user_type) === 8) return hinted;

  if (!req.user?.id) return null;

  const allowed = (await db.any(
    `SELECT DISTINCT hospitality_company_id
       FROM tbl_hospitality_user_mappings
      WHERE user_id = $1
        AND hospitality_company_id IS NOT NULL
      ORDER BY hospitality_company_id`,
    [req.user.id]
  )).map((r) => Number(r.hospitality_company_id));

  if (hinted != null) {
    // Honor the client hint ONLY if the user belongs to that company.
    return allowed.includes(hinted) ? hinted : null;
  }
  return allowed.length > 0 ? allowed[0] : null;
}

/**
 * Resolve the FULL set of hospitality companies a request may read — for list /
 * dashboard scope. Unlike resolveHospitalityCompanyId (which collapses to a
 * single company and so silently hides data for multi-company users), this
 * returns EVERY company the user is mapped to, so the ARC listing behaves like
 * the RFQ listing (show everything you can access; narrow with the in-page
 * facets). Still never widens beyond the user's own mappings.
 *
 * Returns: number[] of company ids (possibly empty = no access), or `null` =
 * "no company filter" (super admins, who see every company).
 */
export async function resolveHospitalityCompanyScope(req) {
  // Super admin sees all companies — or a single hinted one if explicitly asked.
  if (Number(req.user?.user_type) === 8) {
    const raw =
      req.query?.hospitality_company_id ||
      req.headers?.['x-hospitality-company'] ||
      req.headers?.['x-hospitality-company-id'];
    const hinted = (raw != null && Number.isFinite(Number(raw)) && Number(raw) > 0) ? Number(raw) : null;
    return hinted != null ? [hinted] : null;
  }
  if (!req.user?.id) return [];

  const allowed = (await db.any(
    `SELECT DISTINCT hospitality_company_id
       FROM tbl_hospitality_user_mappings
      WHERE user_id = $1
        AND hospitality_company_id IS NOT NULL`,
    [req.user.id]
  )).map((r) => Number(r.hospitality_company_id));

  return allowed; // [] = no access → empty results (never "all")
}
