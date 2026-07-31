// ARC v2 — the module's ONE read-scope predicate.
//
// WHY THIS FILE EXISTS
// The 4-axis scope predicate (company × hotel × department × process) had been
// re-typed by hand in five subtly-different forms across the platform, and the
// ARC module carried FOUR byte-identical copies of a `userCanAccessHotel`
// wrapper (arcController, arcContractController, arcCommitteeController,
// arcManualController). Those copies all delegated to
// rbacModel.getAllAccessibleHotelIds, which reads tbl_hospitality_user_mappings
// — a HOTEL-BLIND table: one company-level mapping row (mapping_type = 0)
// expands to EVERY hotel in the company, so a user scoped to a single business
// unit could read every other BU's rate contracts. This module replaces all
// four with one implementation over tbl_user_role_scopes, the authoritative
// RBAC matrix.
//
// SEMANTICS — identical to authorizationService.buildScopeExistsClause /
// assertUserHasScope (app/services/authorizationService.js), which is the
// canonical platform implementation and the reference SQL shape used by the
// RFQ listing (app/models/rfqModel.js):
//   company    — must match exactly (never NULL in tbl_user_role_scopes)
//   hotel      — urs.hotel_id IS NULL  ⇒ every hotel under the company
//   department — permissive when the ENTITY has no department; otherwise the
//                scope row must match it or be NULL
//   process    — strict: urs.process_id IS NULL ⇒ every process. A row bound
//                to a specific process does NOT match a process-less entity.
//
// PROCESS AXIS — enforced here, and it is not a deny-all: all 2,307 production
// tbl_user_role_scopes rows have process_id NULL today, so every existing grant
// is a process wildcard and matches ARCs (which are process-free by design,
// tbl_arc.process_id IS NULL). Enforcing it now means a future process-scoped
// grant behaves exactly as it does for RFQs instead of silently widening.
//
// PERMISSION KEY — deliberately optional, and OFF by default for ARC.
// authorizationService keys its predicate on a `resource.action` permission.
// ARC reads cannot be keyed that way *yet*:
//   · POST /arc-v2 (createDraft) is gated by acl([2,8]) + hotel access only —
//     it does NOT require arc.create. Keying reads on arc.read while creates
//     stay unkeyed would let a buyer create a contract and then not see it.
//   · Approval-policy approvers legitimately hold no ARC module role at all
//     (that is precisely why the decide endpoints are engine-gated rather than
//     requireArcPermission-gated), yet they must see the ARC they are approving.
//   · In production, 0 of 254 scoped users hold ANY arc.* permission today.
// So the default mode enforces scope-row membership without a permission join —
// strictly tighter than the previous behaviour on every axis, and consistent
// with the module's own already-correct permission-agnostic pickers
// (arcModel.getDepartmentsForUserInHotel).
// Passing `{ permissions: ARC_READ_PERMISSIONS }` switches the same predicate
// into the fully permission-keyed form once ARC roles are provisioned; that
// mode delegates to buildScopeExistsClause so there is still only one canonical
// implementation of the keyed clause.

import db from '../../config/dbConn.js';
import { buildScopeExistsClause } from '../../services/authorizationService.js';

// The ARC read family — every permission that should imply "may see this rate
// contract". Used only when a caller opts into permission-keyed mode.
export const ARC_READ_PERMISSIONS = Object.freeze([
  'arc.read',
  'arc.create',
  'arc.admin',
  'arc.approve',
  'arc-tech.read',
  'arc-comm.read',
  'arc-committee.read',
]);

const IDENT = /^[a-zA-Z0-9_.]+$/;

function assertIdent(name, value) {
  if (value == null) return;
  if (typeof value !== 'string' || !IDENT.test(value)) {
    throw new Error(`arcScope: invalid ${name} '${value}'`);
  }
}

/**
 * Build the EXISTS predicate that filters a LIST query by the caller's scope.
 *
 * @param {number|null} userId — null (super admin) ⇒ the clause is `TRUE`.
 * @param {Object} columns
 * @param {string} columns.company    — SQL expression for the row's hospitality company
 * @param {string|null} [columns.hotel]
 * @param {string|null} [columns.department]
 * @param {string|null} [columns.process]
 * @param {number} [paramOffset] — next free $N in the parent query
 * @param {Object} [opts]
 * @param {string[]|null} [opts.permissions] — opt into permission-keyed mode
 * @returns {{ clause: string, params: any[], paramsConsumed: number }}
 */
export function buildArcScopeClause(userId, columns, paramOffset = 1, opts = {}) {
  if (userId == null) return { clause: 'TRUE', params: [], paramsConsumed: 0 };

  const { company, hotel = null, department = null, process = null } = columns || {};
  assertIdent('company column', company);
  assertIdent('hotel column', hotel);
  assertIdent('department column', department);
  assertIdent('process column', process);
  if (!company) throw new Error('arcScope: a company column is required');

  const permissions = Array.isArray(opts.permissions) ? opts.permissions : null;

  // Permission-keyed mode: delegate to the canonical platform helper, OR-ing
  // one clause per permission in the family. Requires the standard alias
  // columns, so it is only available when every axis is present.
  if (permissions && permissions.length > 0) {
    const alias = company.split('.')[0];
    let p = paramOffset;
    const parts = [];
    const params = [];
    for (const perm of permissions) {
      const built = buildScopeExistsClause(userId, perm, alias, p);
      parts.push(built.clause);
      params.push(...built.params);
      p += built.paramsConsumed;
    }
    return { clause: `(${parts.join(' OR ')})`, params, paramsConsumed: params.length };
  }

  const p = paramOffset;
  const predicates = [
    `urs.user_id = $${p}`,
    `urs.company_id = ${company}`,
  ];
  if (hotel) predicates.push(`(urs.hotel_id IS NULL OR urs.hotel_id = ${hotel})`);
  if (department) {
    predicates.push(
      `(${department} IS NULL OR urs.department_id IS NULL OR urs.department_id = ${department})`
    );
  }
  if (process) predicates.push(`(urs.process_id IS NULL OR urs.process_id = ${process})`);

  const clause = `EXISTS (
    SELECT 1 FROM tbl_user_role_scopes urs
     WHERE ${predicates.join('\n       AND ')}
  )`;
  return { clause, params: [userId], paramsConsumed: 1 };
}

/**
 * Object-level equivalent: may this user read/act on an entity carrying this
 * scope tuple? Never throws on a scope miss — returns false.
 *
 * @param {number} userId
 * @param {Object} scope — { hospitality_company_id, hotel_id, department_id, process_id }
 * @param {*} [dbContext]
 */
export async function userHasArcScope(userId, scope, dbContext = db) {
  if (!userId || !scope) return false;
  const companyId = Number(scope.hospitality_company_id) || null;
  const hotelId = scope.hotel_id != null ? Number(scope.hotel_id) : null;
  const deptId = scope.department_id != null ? Number(scope.department_id) : null;
  const processId = scope.process_id != null ? Number(scope.process_id) : null;
  if (!companyId) return false;

  const row = await dbContext.oneOrNone(
    `SELECT 1
       FROM tbl_user_role_scopes urs
      WHERE urs.user_id = $1
        AND urs.company_id = $2
        AND (urs.hotel_id IS NULL OR urs.hotel_id = $3)
        AND ($4::int IS NULL OR urs.department_id IS NULL OR urs.department_id = $4)
        AND (urs.process_id IS NULL OR urs.process_id = $5)
      LIMIT 1`,
    [userId, companyId, hotelId, deptId, processId]
  );
  return !!row;
}

/**
 * THE replacement for the four duplicated `userCanAccessHotel` wrappers.
 * Accepts either a full ARC-like row (preferred — enforces the department and
 * process axes too) or a bare hotel id (the company is then resolved from the
 * hotel, and only the company/hotel axes apply).
 *
 * Super admin (user_type 8) bypasses, exactly as the wrappers did.
 *
 * @param {Object} req — Express request (scope derives from req.user ONLY)
 * @param {Object|number|null} arcOrHotelId
 * @param {*} [dbContext]
 */
export async function userCanAccessArc(req, arcOrHotelId, dbContext = db) {
  if (Number(req?.user?.user_type) === 8) return true;
  const userId = req?.user?.id;
  if (!userId || arcOrHotelId == null) return false;

  if (typeof arcOrHotelId === 'object') {
    const arc = arcOrHotelId;
    // hospitality_company_id is NOT NULL on tbl_arc, but manual/legacy rows may
    // arrive without it selected — fall back to resolving from the hotel.
    if (arc.hospitality_company_id) {
      return userHasArcScope(userId, arc, dbContext);
    }
    return userCanAccessArc(req, arc.hotel_id, dbContext);
  }

  const hotelId = Number(arcOrHotelId);
  if (!hotelId) return false;
  const hotel = await dbContext.oneOrNone(
    `SELECT hospitality_company_id FROM tbl_hospitality_company_hotels
      WHERE id = $1 AND COALESCE(is_deleted, 0) = 0`,
    [hotelId]
  );
  if (!hotel) return false;
  return userHasArcScope(
    userId,
    { hospitality_company_id: hotel.hospitality_company_id, hotel_id: hotelId },
    dbContext
  );
}

/**
 * rbacModel.getUserPermissionsForHotels SELECTs urs.process_id but never
 * filters on it, so its rows enforce only 3 of the 4 axes. Every ARC caller of
 * it runs its rows through this filter so the permission gate agrees with the
 * listing predicate on the process axis.
 *
 * Semantics are the canonical strict ones: a scope row bound to a specific
 * process does NOT grant a process-less entity; NULL on the row is a wildcard.
 * This is NOT a deny-all — all 2,307 production tbl_user_role_scopes rows carry
 * process_id NULL today, so every existing grant is a wildcard and keeps
 * matching ARCs (which are process-free by design).
 *
 * @param {Array} rows — rows from rbacModel.getUserPermissionsForHotels
 * @param {number|null} entityProcessId
 */
export function filterRowsByProcessAxis(rows, entityProcessId) {
  const target = entityProcessId != null ? Number(entityProcessId) : null;
  return (rows || []).filter(
    (r) => r.process_id == null || (target != null && Number(r.process_id) === target)
  );
}

/**
 * `null` for super admins (= "no scope filter"), else the caller's user id —
 * the single value every scoped ARC model call needs. Keeps the super-admin
 * bypass in ONE place instead of at each query site.
 *
 * Fails CLOSED: with no authenticated user it yields 0, which matches no
 * tbl_user_role_scopes row (rather than null, which would mean "see all").
 */
export function arcScopeUserId(req) {
  if (Number(req?.user?.user_type) === 8) return null;
  return req?.user?.id ?? 0;
}

export default {
  ARC_READ_PERMISSIONS,
  buildArcScopeClause,
  userHasArcScope,
  userCanAccessArc,
  filterRowsByProcessAxis,
  arcScopeUserId,
};
