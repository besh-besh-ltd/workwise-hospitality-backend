// Purchase Requisitions — review routing and the routing preview (spec §6, §7, §8).
//
//   resolveReviewDepartment / computeReviewGroups
//       Which department technically reviews which lines: the company's
//       category → department map (tbl_pr_review_category_map), nearest
//       mapping first — the line's own category, else its parent, up to
//       REVIEW_PARENT_LEVELS levels up. Unmapped lines need no review.
//   resolveReviewers
//       Who may review a group: REVIEWERS_SQL, the list form of the predicate
//       the lists use (REVIEWER_EXISTS_SQL), so the two cannot disagree.
//   previewApproval
//       Who approves, step by step, through the approval engine's own
//       resolver (generalModel.resolvePolicyChain) — the function
//       createApprovalInstance builds instances from. Nothing here re-derives
//       approvers, thresholds or separation of duties.
//   previewRouting
//       All of the above for one PR-shaped input, plus the ordered list of
//       blocking problems.
//
// SUBMIT CALLS THESE SAME FUNCTIONS (Tasks 6/7): the preview a requester sees
// and the checks submit refuses on are one computation, so they can never
// disagree. Everything here is read-only and takes a db/task/tx `t`.

import db from '../../config/dbConn.js';
import { findBestMatchingPolicyTx, resolvePolicyChain } from '../../models/generalModel.js';
import { REVIEWERS_SQL } from './prConstants.js';

/** How many parent levels a category may inherit its reviewing department from. */
export const REVIEW_PARENT_LEVELS = 3;

const toIds = (ids) => [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

/**
 * The reviewing department of each category for a company, by nearest
 * mapping: the category itself (depth 0), else its parent, … up to
 * REVIEW_PARENT_LEVELS levels up (parent_id 0/NULL ends the walk). Categories
 * with no mapping on the way up are absent from the map.
 * @returns {Promise<Map<number, {department_id: number, department_title: string}>>}
 */
export async function reviewDepartmentsFor(companyId, categoryIds, t = db) {
  const ids = toIds(categoryIds);
  const out = new Map();
  if (!companyId || !ids.length) return out;
  const rows = await t.any(
    `WITH RECURSIVE chain AS (
       SELECT c.id AS start_id, c.id AS category_id, c.parent_id, 0 AS depth
         FROM tbl_category c
        WHERE c.id = ANY($2::int[])
       UNION ALL
       SELECT ch.start_id, up.id, up.parent_id, ch.depth + 1
         FROM chain ch
         JOIN tbl_category up ON up.id = ch.parent_id
        WHERE ch.depth < $3
     )
     SELECT DISTINCT ON (ch.start_id) ch.start_id, m.department_id, d.title AS department_title
       FROM chain ch
       JOIN tbl_pr_review_category_map m
         ON m.hospitality_company_id = $1 AND m.category_id = ch.category_id
       JOIN tbl_department d ON d.id = m.department_id
      ORDER BY ch.start_id, ch.depth`,
    [Number(companyId), ids, REVIEW_PARENT_LEVELS]
  );
  for (const r of rows) {
    out.set(Number(r.start_id), { department_id: Number(r.department_id), department_title: r.department_title });
  }
  return out;
}

/** The department that reviews lines of `categoryId` in this company, or null. */
export async function resolveReviewDepartment(companyId, categoryId, t = db) {
  return (await reviewDepartmentsFor(companyId, [categoryId], t)).get(Number(categoryId))?.department_id ?? null;
}

/**
 * Review groups for a PR's lines: one per reviewing department, holding the
 * lines routed to it. Lines of unmapped categories are in no group.
 * @param {{companyId: number, lines: Array<{id?: number, line_no: number, category_id: number}>}} p
 * @returns {Promise<Array<{department_id, department_title, line_nos: number[], line_ids: number[]}>>}
 *   sorted by department title (then id); line_nos ascending.
 */
export async function computeReviewGroups({ companyId, lines }, t = db) {
  const list = lines || [];
  const routes = await reviewDepartmentsFor(companyId, list.map((l) => l.category_id), t);
  const groups = new Map();
  for (const line of list) {
    const route = routes.get(Number(line.category_id));
    if (!route) continue;
    if (!groups.has(route.department_id)) groups.set(route.department_id, { ...route, lines: [] });
    groups.get(route.department_id).lines.push(line);
  }
  return [...groups.values()]
    .map((g) => {
      const sorted = g.lines.sort((a, b) => Number(a.line_no) - Number(b.line_no));
      return {
        department_id: g.department_id,
        department_title: g.department_title,
        line_nos: sorted.map((l) => Number(l.line_no)),
        line_ids: sorted.filter((l) => l.id != null).map((l) => Number(l.id)),
      };
    })
    .sort((a, b) => String(a.department_title).localeCompare(String(b.department_title))
      || a.department_id - b.department_id);
}

/**
 * Eligible reviewers for (company, hotel, reviewing department), ordered by
 * name. Includes the requester when they are eligible (spec §6.2: a
 * self-review is allowed and recorded; SoD is enforced at approval).
 *
 * Not authorizationService.listUsersWithAnyScope: its axes match, but it
 * returns grants, not reviewers — it applies neither the active-account nor
 * the hospitality-mapping rule, and REVIEWER_EXISTS_SQL (the lists) must
 * answer exactly the same question as this list.
 * @returns {Promise<Array<{id: number, name: string}>>}
 */
export async function resolveReviewers({ companyId, hotelId, departmentId }, t = db) {
  if (!companyId || !hotelId || !departmentId) return [];
  const rows = await t.any(REVIEWERS_SQL('$1', '$2', '$3'), [Number(companyId), Number(hotelId), Number(departmentId)]);
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

// Engine problem codes → the PR codes submit answers with (spec §7).
const ENGINE_TO_PR = Object.freeze({
  APPROVAL_STEP_UNRESOLVED: 'PR_STEP_UNRESOLVED',
  APPROVAL_NO_INDEPENDENT_APPROVER: 'PR_NO_INDEPENDENT_APPROVER',
});
// Skips that are the policy working as designed; every other skip is a problem.
const ROUTINE_SKIPS = new Set(['below_threshold', 'sod_self']);

const CONTACT_ADMIN = 'contact your admin to update the approval workflow';

/** Policy steps with a display label; the resolver loads its own copy of the steps. */
async function labelledPolicySteps(policyId, t) {
  return t.any(
    `SELECT s.id, s.step_order, s.decision_rule, s.approver_source_type, s.approver_source_id, s.min_amount,
            CASE s.approver_source_type
              WHEN 'ROLE'       THEN r.title
              WHEN 'USER'       THEN u.name
              WHEN 'DEPARTMENT' THEN d.title
            END AS label
       FROM tbl_approval_policy_steps s
       LEFT JOIN tbl_roles r ON s.approver_source_type = 'ROLE' AND r.id = s.approver_source_id
       LEFT JOIN tbl_users u ON s.approver_source_type = 'USER' AND u.id = s.approver_source_id
       LEFT JOIN tbl_department d ON s.approver_source_type = 'DEPARTMENT' AND d.id = s.approver_source_id
      WHERE s.approval_policy_id = $1
      ORDER BY s.step_order, s.id`,
    [policyId]
  );
}

async function userNames(ids, t) {
  const list = toIds(ids);
  if (!list.length) return new Map();
  const rows = await t.any(`SELECT id, name FROM tbl_users WHERE id = ANY($1::int[])`, [list]);
  return new Map(rows.map((r) => [Number(r.id), r.name]));
}

function stepLabel(step) {
  if (step.label) return step.label;
  const kind = { ROLE: 'Role', USER: 'User', DEPARTMENT: 'Department' }[step.approver_source_type] || 'Approver';
  return `${kind} #${step.approver_source_id}`;
}

function approvalProblem(engineProblem, stepsById, skipped) {
  if (engineProblem.code === 'APPROVAL_STEP_UNRESOLVED') {
    const step = stepsById.get(Number(engineProblem.policy_step_id));
    const label = step ? stepLabel(step) : null;
    return {
      code: ENGINE_TO_PR.APPROVAL_STEP_UNRESOLVED,
      message: `Approval step ${engineProblem.step_order}${label ? ` (${label})` : ''} has no one who can approve `
        + `for this hotel and department — ${CONTACT_ADMIN}`,
      step_order: Number(engineProblem.step_order),
      reason: engineProblem.reason,
    };
  }
  if (engineProblem.code === 'APPROVAL_NO_INDEPENDENT_APPROVER') {
    // Same refusal, two causes worth telling apart: every level that applies
    // resolved only to the requester, or no level applies at this value.
    const selfOnly = skipped.some((s) => s.reason === 'sod_self');
    return {
      code: ENGINE_TO_PR.APPROVAL_NO_INDEPENDENT_APPROVER,
      message: selfOnly
        ? `No one other than the requester can approve this requisition — ${CONTACT_ADMIN}`
        : `No approval step applies to a requisition of this value — ${CONTACT_ADMIN}`,
    };
  }
  // The resolver documents only the two codes above. Anything new fails closed
  // under its own code rather than being dropped.
  return { code: engineProblem.code, message: `The approval chain cannot be started — ${CONTACT_ADMIN}` };
}

/**
 * The approval chain a PR would get if submitted now — the steps the engine
 * would create, the steps it would skip by design, and why submit would refuse.
 *
 * @param {{companyId, hotelId, departmentId, amount, requesterId}} p
 *   amount: the server-computed estimated total (2-decimal string).
 *   requesterId: the PR's requester (raised_by), never the viewer — separation
 *   of duties is about who raised it.
 * @returns {Promise<{policy_id: number|null, steps: Array, problems: Array}>}
 *   steps — every policy step in policy order:
 *     { step_order, label, approver_source_type, approver_source_id, decision_rule,
 *       min_amount, applies, approvers: [{id, name}], skipped_reason }
 *     applies=false only for a step skipped by design (skipped_reason
 *     'below_threshold' | 'sod_self'). A step that cannot resolve applies with
 *     no approvers and is named by a PR_STEP_UNRESOLVED problem.
 *   problems — what submit refuses on, in order: PR_NO_POLICY |
 *     PR_STEP_UNRESOLVED {step_order, reason} | PR_NO_INDEPENDENT_APPROVER.
 */
export async function previewApproval({ companyId, hotelId, departmentId, amount, requesterId }, t = db) {
  const policy = await findBestMatchingPolicyTx({
    entity_type: 'PR', hospitality_company_id: companyId, hotel_id: hotelId, department_id: departmentId, process_id: null,
  }, t);
  if (!policy) {
    return {
      policy_id: null,
      steps: [],
      problems: [{ code: 'PR_NO_POLICY', message: `No approval workflow is set up for purchase requisitions at this hotel — ${CONTACT_ADMIN}` }],
    };
  }
  const policyId = Number(policy.id);
  const labelled = await labelledPolicySteps(policyId, t);
  if (!labelled.length) {
    // createApprovalInstance refuses a step-less policy before resolving it.
    return {
      policy_id: policyId,
      steps: [],
      problems: [{ code: 'PR_NO_POLICY', message: `The approval workflow for this hotel has no steps — ${CONTACT_ADMIN}` }],
    };
  }

  const chain = await resolvePolicyChain({
    entity_type: 'PR',
    policy_id: policyId,
    hospitality_company_id: companyId,
    hotel_id: hotelId,
    department_id: departmentId,
    process_id: null,
    initiated_by: requesterId,
    amount,
  }, t);

  const approversByStep = new Map(chain.steps.map((s) => [Number(s.policy_step.id), s.approverIds.map(Number)]));
  const skipByStep = new Map(chain.skipped.map((s) => [Number(s.policy_step_id), s.reason]));
  const names = await userNames([...approversByStep.values()].flat(), t);

  const steps = labelled.map((s) => {
    const skip = skipByStep.get(Number(s.id));
    const skippedReason = ROUTINE_SKIPS.has(skip) ? skip : null;
    const approvers = (approversByStep.get(Number(s.id)) || [])
      .map((id) => ({ id, name: names.get(id) ?? null }))
      .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')) || a.id - b.id);
    return {
      step_order: Number(s.step_order),
      label: stepLabel(s),
      approver_source_type: s.approver_source_type,
      approver_source_id: s.approver_source_id == null ? null : Number(s.approver_source_id),
      decision_rule: s.decision_rule,
      min_amount: s.min_amount ?? null,
      applies: skippedReason === null,
      approvers,
      skipped_reason: skippedReason,
    };
  });

  const stepsById = new Map(labelled.map((s) => [Number(s.id), s]));
  return { policy_id: policyId, steps, problems: chain.problems.map((p) => approvalProblem(p, stepsById, chain.skipped)) };
}

// ---------------------------------------------------------------------------
// Whole preview
// ---------------------------------------------------------------------------

/** The PR_NO_REVIEWER problem for a review group nobody can review — shared with submit (prWorkflow.startReview). */
export const noReviewerProblem = (group) => ({
  code: 'PR_NO_REVIEWER',
  message: `No one can technically review the ${group.department_title} lines for this hotel — `
    + 'ask your admin to grant the PR Technical Reviewer role',
  department_id: group.department_id,
  department_title: group.department_title,
});

/**
 * Review groups with their reviewers, the approval chain, and every blocking
 * problem in the order submit meets them: review groups without a reviewer
 * (PR_NO_REVIEWER, by department title), then the approval problems.
 *
 * @param {Object} p
 * @param {number} p.companyId, p.hotelId, p.departmentId - the PR's cell
 * @param {number} p.requesterId - the PR's requester (raised_by)
 * @param {string} p.amount - server-computed Σ ROUND(qty × price, 2) of active lines
 * @param {Array<{id?, line_no, category_id}>} p.lines - active lines, categories already server-derived
 * @returns {Promise<{amount, reviews, approval, problems}>}
 */
export async function previewRouting({ companyId, hotelId, departmentId, requesterId, amount, lines }, t = db) {
  const groups = await computeReviewGroups({ companyId, lines }, t);
  const reviews = [];
  for (const g of groups) {
    const reviewers = await resolveReviewers({ companyId, hotelId, departmentId: g.department_id }, t);
    const problem = reviewers.length ? null : noReviewerProblem(g);
    reviews.push({ ...g, reviewers, problem });
  }
  const approval = await previewApproval({ companyId, hotelId, departmentId, amount, requesterId }, t);
  return {
    amount,
    reviews,
    approval,
    problems: [...reviews.filter((r) => r.problem).map((r) => r.problem), ...approval.problems],
  };
}

export default {
  REVIEW_PARENT_LEVELS, reviewDepartmentsFor, resolveReviewDepartment, computeReviewGroups, resolveReviewers,
  previewApproval, previewRouting, noReviewerProblem,
};
