// Purchase Requisitions — who may do what (spec §3, §12).
//
// Two questions, answered here and nowhere else:
//
//   hasPerm / assertPerm   "may this user <pr.action> on this (company × hotel ×
//                           department) cell?"  — authorizationService's own
//                           scope predicate, so PR shares the platform's NULL /
//                           wildcard semantics exactly. PRs carry process_id
//                           NULL, so only process-wildcard scope rows apply.
//
//   canReadPr /            "may this user read this PR?" — ONE SQL predicate
//   readableScopeSql        (readableScopeSql) serves both the point read and
//                           every list, so a list can never answer a wider
//                           question than GET /pr/:id does, nor a narrower one.
//
// Scope is always derived from req.user and the PR row, never from the body.

import db from '../../config/dbConn.js';
import { assertUserHasScope, isAuthorizationError } from '../authorizationService.js';
import { PR_ERR, prError } from './prErrors.js';
import { prGrantRowsSql } from './prConstants.js';

export { prGrantRowsSql };

const SUPER_ADMIN = 8;
export const isSuperAdmin = (user) => Number(user?.user_type) === SUPER_ADMIN;

/** The PR's own (company, hotel, department) cell — the only scope its mutations are checked against. */
export const cellOf = (pr) => ({
  companyId: Number(pr.hospitality_company_id), hotelId: Number(pr.hotel_id), departmentId: Number(pr.department_id),
});
/** Did `user` raise this PR? */
export const isRequester = (user, pr) => Number(pr?.raised_by) === Number(user?.id);
/** The one "no such PR / not yours to see" refusal (404, never 403 — no existence leak). */
export const notFound = () => prError(PR_ERR.NOT_FOUND, 'Purchase requisition not found');

/**
 * Does `userId` hold `perm` ('pr.create', 'pr.convert'…) on the cell?
 * departmentId null = "on any department of the hotel" (the scope predicate is
 * department-permissive when the entity side is NULL).
 */
export async function hasPerm(userId, perm, { companyId, hotelId = null, departmentId = null } = {}, t = db) {
  if (!userId || !companyId) return false;
  try {
    await assertUserHasScope(userId, perm, {
      hospitality_company_id: companyId,
      hotel_id: hotelId,
      department_id: departmentId,
      process_id: null,
    }, t);
    return true;
  } catch (err) {
    if (isAuthorizationError(err)) return false;
    throw err;
  }
}

// What a refusal says, per permission — the FE shows it as is.
const FORBIDDEN_MESSAGE = {
  'pr.create': 'You do not have access to raise purchase requisitions for this hotel/department',
  'pr.read': 'You do not have access to purchase requisitions for this hotel/department',
  'pr.evaluate': 'You are not a technical reviewer for this department',
  'pr.approve': 'You are not an approver for purchase requisitions of this hotel/department',
  'pr.convert': 'You do not have access to work the purchase queue for this hotel',
};
export const forbiddenMessage = (perm) =>
  FORBIDDEN_MESSAGE[perm] || `You do not have the ${perm} permission for this hotel/department`;

export async function assertPerm(userId, perm, cell, t = db) {
  if (!(await hasPerm(userId, perm, cell, t))) {
    throw prError(PR_ERR.FORBIDDEN, forbiddenMessage(perm), { permission: perm });
  }
}

// Aliases used INSIDE the predicate. A caller's own alias must not collide with
// them, or the correlation would silently bind to the inner table.
const RESERVED_ALIASES = new Set(['_pr_urs', '_pr_rp', '_pr_perm', '_pr_rv', '_pr_ai', '_pr_ais', '_pr_asa']);

/**
 * The PR read rule as a SQL boolean over the PR row aliased `alias`:
 *
 *   requester                      alias.raised_by = $user
 *   pr.read     on (company, hotel, PR department)
 *   pr.convert  on (company, hotel, any department)            — the buyer pool
 *   pr.evaluate on (company, hotel, d) for any d the PR was routed to for
 *               review, in any revision                        — reviewers
 *   a non-removed approver row on the PR's CURRENT approval instance
 *               (alias.approval_instance_id). Approvers of an earlier,
 *               cancelled instance need pr.read like anyone else.
 *
 * Super admin (user_type 8) is NOT expressed here — callers skip the clause for
 * them (canReadPr returns true before reaching SQL).
 *
 * The scope join mirrors authorizationService.scopeMatchWhere with the PR as
 * the entity: company exact, hotel exact-or-wildcard, department exact-or-
 * wildcard, process wildcard-only (PR.process_id is NULL).
 *
 * @returns {{ clause: string, params: any[] }}  params = [userId], bound at $paramOffset
 */
export function readableScopeSql(userId, alias = 'p', paramOffset = 1) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias) || RESERVED_ALIASES.has(alias)) {
    throw new Error(`readableScopeSql: invalid alias '${alias}'`);
  }
  return { clause: readableClause(`$${Number(paramOffset)}`, alias), params: [userId] };
}

/** THE read predicate, for the user at SQL expression `u` (a $n placeholder or a trusted column). */
function readableClause(u, alias) {
  return `(
    ${alias}.raised_by = ${u}
    OR EXISTS (
      SELECT 1
        FROM tbl_user_role_scopes _pr_urs
        JOIN tbl_role_permissions _pr_rp ON _pr_rp.role_id = _pr_urs.role_id
        JOIN tbl_permissions _pr_perm ON _pr_perm.id = _pr_rp.permission_id
       WHERE _pr_urs.user_id = ${u}
         AND _pr_urs.company_id = ${alias}.hospitality_company_id
         AND (_pr_urs.hotel_id IS NULL OR _pr_urs.hotel_id = ${alias}.hotel_id)
         AND (_pr_urs.process_id IS NULL OR _pr_urs.process_id = ${alias}.process_id)
         AND _pr_perm.resource::text = 'pr'
         AND (
              (_pr_perm.action::text = 'read'
                AND (_pr_urs.department_id IS NULL OR _pr_urs.department_id = ${alias}.department_id))
           OR _pr_perm.action::text = 'convert'
           OR (_pr_perm.action::text = 'evaluate'
                AND EXISTS (SELECT 1 FROM tbl_pr_review _pr_rv
                             WHERE _pr_rv.pr_id = ${alias}.id
                               AND (_pr_urs.department_id IS NULL OR _pr_urs.department_id = _pr_rv.department_id)))
         )
    )
    OR EXISTS (
      SELECT 1
        FROM tbl_approval_instances _pr_ai
        JOIN tbl_approval_instance_steps _pr_ais ON _pr_ais.approval_instance_id = _pr_ai.id
        JOIN tbl_approval_step_approvers _pr_asa ON _pr_asa.approval_instance_step_id = _pr_ais.id
       WHERE _pr_ai.id = ${alias}.approval_instance_id
         AND _pr_ai.entity_type = 'PR'
         AND _pr_ai.entity_id = ${alias}.id
         AND _pr_asa.approver_user_id = ${u}
         AND _pr_asa.removed_at IS NULL
         AND COALESCE(_pr_asa.status, 'PENDING') <> 'REMOVED'
    )
  )`;
}

/**
 * Point read. `pr` needs at least { id, raised_by }. Same predicate as lists
 * (readableScopeSql) — evaluated against the PR's committed row.
 */
export async function canReadPr(user, pr, t = db) {
  if (!user?.id || !pr?.id) return false;
  if (isSuperAdmin(user)) return true;
  if (Number(pr.raised_by) === Number(user.id)) return true;
  const { clause, params } = readableScopeSql(user.id, 'p', 2);
  const row = await t.one(
    `SELECT EXISTS (SELECT 1 FROM tbl_purchase_requisition p WHERE p.id = $1 AND ${clause}) AS ok`,
    [pr.id, ...params]
  );
  return row.ok === true;
}

/**
 * Which of `userIds` may read PR `prId` right now — canReadPr for many users
 * in one query: the same predicate (readableClause), plus super admins
 * (user_type 8, as isSuperAdmin). A notification audience is filtered through
 * this so nobody who lost access is sent a PR's content. Ids, de-duplicated,
 * in no particular order; [] when none (or the PR does not exist).
 * @returns {Promise<number[]>}
 */
export async function readersOf(prId, userIds, t = db) {
  const ids = [...new Set((userIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!prId || !ids.length) return [];
  return t.map(
    `SELECT _rd_u.id
       FROM tbl_users _rd_u
       JOIN tbl_purchase_requisition p ON p.id = $1
      WHERE _rd_u.id = ANY($2::int[])
        AND (_rd_u.user_type = ${SUPER_ADMIN} OR ${readableClause('_rd_u.id', 'p')})`,
    [prId, ids], (r) => Number(r.id));
}

export default {
  hasPerm, assertPerm, forbiddenMessage, canReadPr, readersOf, readableScopeSql, prGrantRowsSql, isSuperAdmin,
  cellOf, isRequester, notFound,
};
