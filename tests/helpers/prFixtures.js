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
//   approvedPr / submittedPr      an APPROVED / pending_approval PR, made entirely through the API
//   cleanupRfqDrafts / rfqsOfLines  RFQ drafts made by POST /pr/convert, and finding them

import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { grantRoleScope } from "./roleScope.js";
import { httpClient } from "./http.js";

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

// The test DB is built fresh per run (prepareTestDb) and its catalog tables
// are never ANALYZEd: until autovacuum gets to them the planner believes
// tbl_product holds ~1 row and nested-loops 11.5k products × 13k variants —
// over 60 s, failing whichever suite asks first (seen when another jest run
// loads Postgres and delays autoanalyze). One ANALYZE per process makes the
// catalog reads below deterministic. Setup only — no code under test is involved.
let catalogAnalyzed = false;
async function analyzeCatalogOnce() {
  if (catalogAnalyzed) return;
  await db.none(`ANALYZE tbl_product, tbl_product_variant, tbl_product_categories, tbl_category`);
  catalogAnalyzed = true;
}

/**
 * The lowest-id variant that the RFQ "usable" predicate admits and whose
 * product has a category. category_id = the product's first category by id.
 */
export async function firstUsableVariant() {
  await analyzeCatalogOnce();
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

// ---------------------------------------------------------------------------
// Approved PRs (the buyer pool's input)
// ---------------------------------------------------------------------------
const clientCache = new Map();
async function clientFor(userId) {
  if (!clientCache.has(userId)) clientCache.set(userId, await httpClient(userId));
  return clientCache.get(userId);
}

/**
 * Create a draft through the API and submit it under a fresh hotel-level PR
 * policy whose only step is USER `approverId` (the newest, most specific
 * policy for the hotel, so it is the one submit matches). Returns the PR and
 * the policy id; the caller deactivates the policy. A PR that fails half-way
 * is deleted here (the caller never learns its id).
 */
async function createAndSubmit(lines, {
  requesterId = IDS.users.a1_eng_buyer,
  approverId = IDS.users.a1_proc_commApp,
  companyId = IDS.hospitality.A,
  hotelId = IDS.hotels.A1,
  departmentId = IDS.departments.eng,
  ...header
} = {}) {
  const requester = await clientFor(requesterId);
  const created = await requester.post("/api/v1/pr")
    .send(await draftBody({ hotel_id: hotelId, department_id: departmentId, ...header, lines }));
  if (created.status !== 200) throw new Error(`approvedPr: create ${created.status} ${JSON.stringify(created.body)}`);
  const { id, pr_number } = created.body.data;

  const policyId = await makePrPolicy({ companyId, hotelId, steps: [{ source: "USER", id: approverId }] });
  try {
    const submitted = await requester.post(`/api/v1/pr/${id}/submit`).send({});
    if (submitted.status !== 200 || submitted.body.data?.pr?.status !== "pending_approval") {
      throw new Error(`approvedPr: submit ${submitted.status} ${JSON.stringify(submitted.body?.data?.pr?.status ?? submitted.body)}`);
    }
    const row = await db.one(`SELECT approval_instance_id FROM tbl_purchase_requisition WHERE id = $1`, [id]);
    const lineIds = await db.map(
      `SELECT id FROM tbl_purchase_requisition_line WHERE pr_id = $1 ORDER BY line_no`, [id], (r) => Number(r.id));
    return { pr: { id, pr_number, line_ids: lineIds, instance_id: Number(row.approval_instance_id) }, policyId };
  } catch (err) {
    await cleanupPrs([id]);
    await db.none(`UPDATE tbl_approval_policies SET is_active = false WHERE id = $1`, [policyId]);
    throw err;
  }
}

/**
 * A PR waiting for approval (pending_approval), made through the API like
 * approvedPr (steps 1–3 below) but never approved. Same options and caller
 * duties as approvedPr.
 * @returns {Promise<{id: number, pr_number: string, line_ids: number[], instance_id: number}>}
 */
export async function submittedPr(lines, opts = {}) {
  const { pr, policyId } = await createAndSubmit(lines, opts);
  await db.none(`UPDATE tbl_approval_policies SET is_active = false WHERE id = $1`, [policyId]);
  return pr;
}

/**
 * An APPROVED PR, made the way users make one — entirely through the API:
 *   1. `requesterId` creates a draft of `lines` (POST /api/v1/pr; each line in
 *      the create payload's shape) at (companyId, hotelId, departmentId);
 *   2. a fresh hotel-level PR policy whose only step is USER `approverId` — the
 *      newest, most specific policy for the hotel, so it is the one submit
 *      matches;
 *   3. the requester submits. No review: the caller keeps the company's review
 *      routing empty for these categories (unmapAll) — a PR that lands in
 *      in_review throws here;
 *   4. the approver approves through POST /general/hospitality/approval/action.
 * The policy is then deactivated (dropPrPolicies deletes it later).
 *
 * The caller grants the roles (PR Requester on the cell, PR Approver for the
 * approver), sets their user_type to 2, and deletes the PR with cleanupPrs.
 * `header` overrides the draft header (title, urgency, required_by_date…).
 * @returns {Promise<{id: number, pr_number: string, line_ids: number[], instance_id: number}>}
 *   line_ids in line order.
 */
export async function approvedPr(lines, opts = {}) {
  const { pr, policyId } = await createAndSubmit(lines, opts);
  try {
    const approver = await clientFor(opts.approverId ?? IDS.users.a1_proc_commApp);
    const approved = await approver.post("/api/v1/general/hospitality/approval/action")
      .send({ approval_instance_id: pr.instance_id, action: "APPROVE", comment: "ok" });
    const after = await db.one(`SELECT status FROM tbl_purchase_requisition WHERE id = $1`, [pr.id]);
    if (approved.status !== 200 || after.status !== "approved") {
      throw new Error(`approvedPr: approve ${approved.status} → PR ${after.status} ${JSON.stringify(approved.body)}`);
    }
    return pr;
  } catch (err) {
    await cleanupPrs([pr.id]); // the caller never learns the id of a PR that failed half-way
    throw err;
  } finally {
    await db.none(`UPDATE tbl_approval_policies SET is_active = false WHERE id = $1`, [policyId]);
  }
}

// ---------------------------------------------------------------------------
// RFQ drafts built by POST /pr/convert
// ---------------------------------------------------------------------------

/**
 * Delete RFQs (drafts made by conversion, or test RFQs) and every row hanging
 * off them: tech evaluations + clauses, product files, specs, invited vendors,
 * products, hotel mappings, terms, and the RFQ (its tbl_pr_line_rfq links
 * cascade). POs are the caller's (cleanupPurchaseOrders) — delete them first.
 */
export async function cleanupRfqDrafts(rfqIds) {
  const ids = [...new Set((rfqIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return;
  await db.none(
    `DELETE FROM tbl_rfq_product_tech_evaluation_clauses
      WHERE tbl_rfq_product_tech_evaluation_id IN (
        SELECT id FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1::int[]))`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(
    `DELETE FROM tbl_rfq_product_files
      WHERE rfq_product_id IN (SELECT id FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[]))`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_terms_map WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [ids]);
}

/** Every RFQ any of these PR lines was ever converted into (call BEFORE cleanupPrs). */
export async function rfqsOfLines(lineIds) {
  const ids = (lineIds || []).map(Number).filter(Boolean);
  if (!ids.length) return [];
  return db.map(
    `SELECT DISTINCT rfq_id FROM tbl_pr_line_rfq WHERE pr_line_id = ANY($1::int[])`, [ids], (r) => Number(r.rfq_id));
}
