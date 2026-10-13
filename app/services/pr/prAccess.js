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

const SUPER_ADMIN = 8;
export const isSuperAdmin = (user) => Number(user?.user_type) === SUPER_ADMIN;

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

export async function assertPerm(userId, perm, cell, t = db) {
  if (!(await hasPerm(userId, perm, cell, t))) {
    throw prError(PR_ERR.FORBIDDEN, 'You do not have access to raise purchase requisitions for this hotel/department', {
      permission: perm,
    });
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
 *   a non-removed approver row on any 'PR' approval instance of this PR
 *               (every revision, so a past approver keeps the history)
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
  const u = `$${Number(paramOffset)}`;
  const clause = `(
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
       WHERE _pr_ai.entity_type = 'PR'
         AND _pr_ai.entity_id = ${alias}.id
         AND _pr_asa.approver_user_id = ${u}
         AND _pr_asa.removed_at IS NULL
         AND COALESCE(_pr_asa.status, 'PENDING') <> 'REMOVED'
    )
  )`;
  return { clause, params: [userId] };
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
 * Scope rows of `$userParam` that grant pr.<action> and can apply to a PR
 * (process wildcard). Columns: company_id, hotel_id, department_id.
 * Used by the create-form pickers so they offer exactly what assertPerm admits.
 */
export const prGrantRowsSql = (userParam, action) => {
  if (!/^[a-z]+$/.test(action)) throw new Error(`prGrantRowsSql: invalid action '${action}'`);
  return `
    SELECT _g_urs.company_id, _g_urs.hotel_id, _g_urs.department_id
      FROM tbl_user_role_scopes _g_urs
      JOIN tbl_role_permissions _g_rp ON _g_rp.role_id = _g_urs.role_id
      JOIN tbl_permissions _g_perm ON _g_perm.id = _g_rp.permission_id
     WHERE _g_urs.user_id = ${userParam}
       AND _g_urs.process_id IS NULL
       AND _g_perm.resource::text = 'pr'
       AND _g_perm.action::text = '${action}'`;
};

export default { hasPerm, assertPerm, canReadPr, readableScopeSql, prGrantRowsSql, isSuperAdmin };
