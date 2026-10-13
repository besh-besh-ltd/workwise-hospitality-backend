// Shared fixtures for the Purchase Requisition (PR) suites (tests/services/pr.*).
//
// Everything here is SETUP or CLEANUP — never a re-implementation of the code
// under test (tests/CONVENTIONS.md §1). Suites use Pattern B: commit, then clean
// up by tracked ids in afterAll/afterEach.
//
//   grantPr / revokeAllPr        PR system roles on tbl_user_role_scopes
//   makePrPolicy / dropPrPolicies  entity_type 'PR' approval policies
//   draftBody / firstUsableVariant a valid POST /api/v1/pr payload
//   cleanupPrs                    PR rows + their approval instances
//   mapCategory / unmapAll        category → reviewing-department routing rows
//   istDate                       an IST calendar date, computed by Postgres

import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { grantRoleScope } from "./roleScope.js";

const PR_ROLE_TITLES = ["PR Requester", "PR Technical Reviewer", "PR Approver", "PR Buyer"];
const roleIdCache = new Map();

/** id of a seeded PR system role (created_by IS NULL), e.g. prRoleId('PR Requester'). */
export async function prRoleId(title) {
  if (!roleIdCache.has(title)) {
    const row = await db.one(
      `SELECT id FROM tbl_roles WHERE title = $1 AND created_by IS NULL`, [title]);
    roleIdCache.set(title, Number(row.id));
  }
  return roleIdCache.get(title);
}

/**
 * Grant a PR system role on one (company × hotel × department) cell.
 * hotelId/departmentId null = all hotels / all departments (wildcard).
 * Returns the tbl_user_role_scopes id.
 */
export async function grantPr(userId, roleTitle, {
  companyId = IDS.hospitality.A,
  hotelId = IDS.hotels.A1,
  departmentId = null,
} = {}) {
  return grantRoleScope(db, {
    userId,
    roleId: await prRoleId(roleTitle),
    companyId,
    hotelId,
    departmentId,
  });
}

/** Remove every PR-role scope row held by these users. */
export async function revokeAllPr(userIds) {
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
  if (!ids.length) return;
  const roleIds = [];
  for (const t of PR_ROLE_TITLES) roleIds.push(await prRoleId(t));
  await db.none(
    `DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[]) AND role_id = ANY($2::int[])`,
    [ids, roleIds]);
}

// ---------------------------------------------------------------------------
// Approval policies
// ---------------------------------------------------------------------------
const policyIds = [];

/**
 * A PR approval policy (process-free, company-wide unless hotelId is given).
 * steps: [{ source: 'USER'|'ROLE'|'DEPARTMENT', id, rule = 'ANY', min_amount = null }]
 * Returns the policy id; dropPrPolicies() removes every policy made here.
 */
export async function makePrPolicy({ companyId = IDS.hospitality.A, hotelId = null, steps = [] } = {}) {
  const policy = await db.one(
    `INSERT INTO tbl_approval_policies
       (entity_type, hospitality_company_id, hotel_id, department_id, is_active, created_by,
        process_id, is_master, is_department_scoped, version)
     VALUES ('PR', $1, $2, NULL, true, $3, NULL, false, false, 1)
     RETURNING id`,
    [companyId, hotelId, IDS.users.superAdmin]);
  const policyId = Number(policy.id);
  policyIds.push(policyId);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id, min_amount)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [policyId, i + 1, s.rule || "ANY", s.source, s.id, s.min_amount ?? null]);
  }
  return policyId;
}

async function deleteApprovalInstances(instanceIds) {
  if (!instanceIds.length) return;
  await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
  await db.none(
    `DELETE FROM tbl_approval_step_approvers
      WHERE approval_instance_step_id IN (
        SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
    [instanceIds]);
  await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
  await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
}

/** Delete every entity_type 'PR' policy created by makePrPolicy (and any instance still pointing at it). */
export async function dropPrPolicies() {
  if (!policyIds.length) return;
  const ids = policyIds.splice(0);
  const inst = await db.map(
    `SELECT id FROM tbl_approval_instances WHERE approval_policy_id = ANY($1::int[])`, [ids], (r) => Number(r.id));
  await deleteApprovalInstances(inst);
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[]) AND entity_type = 'PR'`, [ids]);
}

/** Delete PRs (lines, events, reviews… cascade) and their 'PR' approval instances. */
export async function cleanupPrs(prIds) {
  const ids = (prIds || []).map(Number).filter(Boolean);
  if (!ids.length) return;
  const inst = await db.map(
    `SELECT id FROM tbl_approval_instances WHERE entity_type = 'PR' AND entity_id = ANY($1::int[])`,
    [ids], (r) => Number(r.id));
  await deleteApprovalInstances(inst);
  await db.none(`DELETE FROM tbl_purchase_requisition WHERE id = ANY($1::int[])`, [ids]);
}

// ---------------------------------------------------------------------------
// Catalog + payloads
// ---------------------------------------------------------------------------

/** An IST calendar date 'YYYY-MM-DD', offset by whole days from today (IST). */
export async function istDate(offsetDays = 0) {
  const row = await db.one(
    `SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date + $1::int, 'YYYY-MM-DD') AS d`,
    [offsetDays]);
  return row.d;
}

/**
 * The lowest-id variant that the RFQ "usable" predicate admits and whose
 * product has a category. category_id = the product's first category by id.
 */
export async function firstUsableVariant() {
  const row = await db.one(
    `SELECT pv.id AS variant_id, pv.name AS variant_name, cat.category_id
       FROM tbl_product_variant pv
       JOIN tbl_product p ON p.id = pv.product_id
       CROSS JOIN LATERAL (
         SELECT pc.category_id FROM tbl_product_categories pc
           JOIN tbl_category c ON c.id = pc.category_id
          WHERE pc.product_id = p.id
          ORDER BY pc.category_id LIMIT 1) cat
      WHERE p.status = 1 AND p.is_deleted = 0 AND p.is_review = 0 AND p.is_approve = 1
        AND pv.is_approve = 1
      ORDER BY pv.id LIMIT 1`);
  return { variant_id: Number(row.variant_id), variant_name: row.variant_name, category_id: Number(row.category_id) };
}

/** Two distinct active, non-deleted category ids, neither equal to `exceptId`. */
async function activeCategories(exceptId) {
  return db.map(
    `SELECT id FROM tbl_category WHERE status = 1 AND is_deleted = 0 AND id <> $1 ORDER BY id LIMIT 2`,
    [exceptId], (r) => Number(r.id));
}

/**
 * A valid create payload for (A, A1, eng): one catalog line and one free-text
 * line. The catalog line deliberately carries a WRONG category_id — the server
 * must derive it from the product. `overrides` is merged over the header;
 * pass `lines` to replace the lines wholesale.
 */
export async function draftBody(overrides = {}) {
  const v = await firstUsableVariant();
  const [otherCat, freeTextCat] = await activeCategories(v.category_id);
  return {
    hotel_id: IDS.hotels.A1,
    department_id: IDS.departments.eng,
    title: "Chiller spares",
    pr_type: "goods",
    urgency: "normal",
    required_by_date: await istDate(14),
    justification: "Chiller 2 compressor is failing",
    delivery_location: "Engineering store",
    lines: [
      {
        product_variant_id: v.variant_id,
        category_id: otherCat, // ignored by the server for catalog lines
        quantity: "2",
        uom: "nos",
        estimated_unit_price: "1500.00",
        specification: "OEM part",
      },
      {
        free_text_name: "Compressor relay 24V",
        category_id: freeTextCat,
        quantity: "4",
        uom: "nos",
        estimated_unit_price: "250.50",
        suggested_vendor_note: "Local dealer stocks it",
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Review routing
// ---------------------------------------------------------------------------

/** Upsert a category → reviewing-department mapping; returns its id. */
export async function mapCategory(companyId, categoryId, departmentId) {
  const row = await db.one(
    `INSERT INTO tbl_pr_review_category_map (hospitality_company_id, category_id, department_id, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (hospitality_company_id, category_id) DO UPDATE SET department_id = EXCLUDED.department_id
     RETURNING id`,
    [companyId, categoryId, departmentId, IDS.users.superAdmin]);
  return Number(row.id);
}

/** Remove every review-routing mapping of a company. */
export async function unmapAll(companyId) {
  await db.none(`DELETE FROM tbl_pr_review_category_map WHERE hospitality_company_id = $1`, [companyId]);
}
