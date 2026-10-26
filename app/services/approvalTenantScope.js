// Tenant scope for approval endpoints: which hospitality companies a request
// may act on, derived from req.user only (never a header or the body).
//
// Moved out of generalController.js so every route that decides an approval
// instance (the generic engine route, the RFQ and tech-eval approval routes,
// the ARC negotiation round routes) answers a foreign instance the same way:
// as if it did not exist.

import db from '../config/dbConn.js';
import { resolveHospitalityCompanyScope } from '../helper/arc_v2/resolveHospitalityCompany.js';
import { requestIsCompanyAdmin } from '../middleware/companyAdmin.js';
import { getApprovalInstanceTenant } from '../models/generalModel.js';

/**
 * Companies this request may read approval config for.
 *   null      → super admin (user_type 8): every company.
 *   number[]  → exactly these companies ([] = no access).
 *
 * resolveHospitalityCompanyScope() reads tbl_hospitality_user_mappings and
 * already refuses client widening for non-admins. Two active production
 * buyers (358, 407) carry RBAC role scopes but no hospitality mapping row, so
 * we union in tbl_user_role_scopes.company_id — still derived entirely from
 * req.user, and it keeps those users from losing their own tenant's policies.
 */
export async function resolveApprovalCompanyScope(req) {
  // Memoised per request: several handlers need the scope more than once
  // (guard + mutation-target resolution) and it costs two queries to build.
  if (req.__approvalCompanyScope !== undefined) return req.__approvalCompanyScope;

  const scope = await computeApprovalCompanyScope(req);
  req.__approvalCompanyScope = scope;
  return scope;
}

async function computeApprovalCompanyScope(req) {
  const mapped = await resolveHospitalityCompanyScope(req);
  if (mapped === null) return null; // super admin (user_type 8)

  const scoped = (await db.any(
    `SELECT DISTINCT company_id
       FROM tbl_user_role_scopes
      WHERE user_id = $1 AND company_id IS NOT NULL`,
    [req.user?.id || null]
  )).map((r) => Number(r.company_id));

  // Company admins own every business unit under their OWN parent buyer
  // company and may carry NEITHER a hospitality mapping NOR an RBAC role scope
  // — verified in production: all three legacy user_type-7 users have zero rows
  // in both tables. Without this union the scope collapses to [] for the only
  // role that may reach the Approval Wizard, so it could neither list nor save
  // a single policy.
  //
  // Keyed on the capability rather than on user_type 7, or an administrator
  // promoted the new way — an ordinary buyer holding company.admin — would fall
  // through to whatever scope they happened to hold as a buyer, which is
  // precisely the estate they were promoted to see beyond.
  //
  // tbl_users.company_id is loaded from the DB by the jwtUsr strategy, so this
  // is still derived entirely from req.user — never from a header or the body.
  // It is the same tenancy edge hospitalityController.js enforces everywhere as
  // `record.buyer_company_id !== company.id`.
  let administered = [];
  if ((await requestIsCompanyAdmin(req)) && req.user?.company_id) {
    administered = (await db.any(
      `SELECT id
         FROM tbl_hospitality_companies
        WHERE buyer_company_id = $1
          AND COALESCE(is_deleted, 0) = 0`,
      [Number(req.user.company_id)]
    )).map((r) => Number(r.id));
  }

  return [...new Set([...(mapped || []), ...scoped, ...administered])];
}


/** True when `companyId` is inside the request's server-derived scope. */
export function inCompanyScope(scopeIds, companyId) {
  if (scopeIds === null) return true; // super admin
  if (companyId === null || companyId === undefined) return false;
  return scopeIds.includes(Number(companyId));
}

/**
 * The instance's tenant row when the request may see it, else null: unknown
 * and foreign instances are the same null, so a caller can answer both with
 * one 404.
 *
 * @param {object} req
 * @param {*} instanceId
 * @returns {Promise<{id:number, hospitality_company_id:number}|null>}
 */
export async function instanceTenantForCaller(req, instanceId) {
  const id = Number(instanceId);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) return null;
  const tenant = await getApprovalInstanceTenant(id);
  if (!tenant) return null;
  const scopeIds = await resolveApprovalCompanyScope(req);
  return inCompanyScope(scopeIds, tenant.hospitality_company_id) ? tenant : null;
}
