// Dashboard widget test helpers — seed a known dashboard state for a user
// so each widget test can assert on exact counts/values.
//
// Each function below creates real rows in the test DB and returns the
// inserted IDs so the test can clean them up + assert on specific records.

import { makeRFQ } from "../factories/rfq.js";
import { IDS } from "../fixtures/ids.js";

/**
 * Wrap makeRFQ so the inserted RFQ ALSO has a tbl_rfq_hotel_mappings row.
 * Dashboard queries scope through tbl_rfq_hotel_mappings (the canonical
 * multi-hotel mapping table) — the makeRFQ factory only writes tbl_rfq.hotel_id
 * which is legacy. Without the mapping the RFQ is invisible to the dashboard.
 *
 * Returns { rfq_id, rfq_no }.
 */
export async function makeRfqVisibleToDashboard(t, opts) {
  const r = await makeRFQ(t, opts);
  await t.none(
    `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by)
     VALUES ($1, $2, $3)`,
    [r.rfq_id, opts.hotel ?? IDS.hotels.A1, opts.createdBy]
  );
  return r;
}

/**
 * Track inserted RFQ ids on a list so afterAll can clean them up.
 * Pattern: caller declares `const inserted = []` at top of describe, then
 * passes it to seed helpers. afterAll calls `cleanupRfqs(inserted)`.
 */
export async function cleanupRfqs(db, rfqIds) {
  if (!rfqIds || rfqIds.length === 0) return;
  // Hotel mappings first (FK).
  await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1)`, [rfqIds]);
  await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1)`, [rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1)`, [rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1)`, [rfqIds]);
}

/**
 * Invite vendors to an RFQ — inserts rows into tbl_rfq_product_vendors.
 * Pass an array of vendor user_ids; each gets a single mapping row with
 * a synthetic product_variant_id (1 is fine for the dashboard purposes —
 * we only care about the count, not the variant).
 */
export async function inviteVendors(t, { rfq_id, vendor_ids, product_variant_id = 1 }) {
  for (const vid of vendor_ids) {
    await t.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, is_rfq_viewed)
       VALUES ($1, $2, $3, 0)`,
      [rfq_id, product_variant_id, vid]
    );
  }
}

/**
 * Insert a tbl_rfq_products row + return its id. Tech-eval rows hang off
 * this. Pulls a product_variant_id from staging-seeded reference data
 * (any valid variant works for dashboard purposes — we only assert on
 * counts and IDs, not on variant attributes).
 */
export async function addProductToRfq(t, rfq_id, opts = {}) {
  const variantId = opts.product_variant_id ?? (
    await t.one(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 1`)
  ).id;
  const row = await t.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
     VALUES ($1, '', '0', '', '', $2, 1)
     RETURNING id`,
    [rfq_id, variantId]
  );
  return { rfq_product_id: row.id, product_variant_id: variantId };
}

/**
 * Create a tech-eval record for a rfq_product. Returns ids of the tech eval
 * and seeded clauses, ready for vendor-response insertion.
 */
export async function makeTechEval(t, { rfq_id, rfq_product_id, isComplete = false, clauseCount = 2 }) {
  const te = await t.one(
    `INSERT INTO tbl_rfq_product_tech_evaluation (rfq_id, tbl_rfq_product_id, is_complete, current_round)
     VALUES ($1, $2, $3, 1)
     RETURNING id`,
    [rfq_id, rfq_product_id, isComplete]
  );
  const clauseIds = [];
  for (let i = 0; i < clauseCount; i++) {
    const c = await t.one(
      `INSERT INTO tbl_rfq_product_tech_evaluation_clauses
         (tbl_rfq_product_tech_evaluation_id, clause_text, weightage, clause_type)
       VALUES ($1, $2, 10, 'clause')
       RETURNING id`,
      [te.id, `Clause ${i + 1}`]
    );
    clauseIds.push(c.id);
  }
  return { tech_eval_id: te.id, clause_ids: clauseIds };
}

/**
 * Record a vendor's response to a tech-eval clause ('agree' / 'disagree').
 * Returns the response row id.
 */
export async function insertVendorTechResponse(t, { clause_id, vendor_id, response }) {
  const row = await t.one(
    `INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response
       (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id, vendor_response)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [clause_id, vendor_id, response]
  );
  return row.id;
}

/**
 * Clean tech-eval related rows for a list of rfq_ids. Call in afterAll.
 */
export async function cleanupTechEvals(db, rfq_ids) {
  if (!rfq_ids || rfq_ids.length === 0) return;
  await db.none(
    `DELETE FROM tbl_rfq_product_tech_evaluation_vendors_response
     WHERE tbl_rfq_product_tech_evaluation_clauses_id IN (
       SELECT c.id FROM tbl_rfq_product_tech_evaluation_clauses c
       JOIN tbl_rfq_product_tech_evaluation te ON te.id = c.tbl_rfq_product_tech_evaluation_id
       WHERE te.rfq_id = ANY($1)
     )`,
    [rfq_ids]
  );
  await db.none(
    `DELETE FROM tbl_rfq_product_tech_evaluation_clauses
     WHERE tbl_rfq_product_tech_evaluation_id IN (
       SELECT id FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1)
     )`,
    [rfq_ids]
  );
  await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1)`, [rfq_ids]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1)`, [rfq_ids]);
}

/**
 * Create an approval instance + step + approver linked to a specific user.
 * Use this to seed pending or completed approval queues for the dashboard
 * widgets that surface approval state (Tech Approver, Commercial Approver,
 * Awarding P1/P2).
 *
 * Required opts:
 *   entity_type      — 'RFQ' | 'TECHNICAL' | 'NEGOTIATION_QUOTE' | 'PO' | ...
 *   entity_id        — id of the underlying entity (rfq_id, tech_eval_id, etc.)
 *   approver_user_id — the user this approval is sitting on
 *   policy_id        — tbl_approval_policies.id
 *   hospitality      — tbl_hospitality_companies.id
 *   hotel            — tbl_hospitality_company_hotels.id
 *
 * Optional opts:
 *   instance_status  — default 'PENDING'; pass 'APPROVED' for throughput tests
 *   approver_status  — default 'PENDING'; pass 'APPROVED' for throughput
 *   acted_ago_hours  — if instance is APPROVED, sets acted_at + completed_at
 *                      to N hours ago (default 0 = unset)
 *   created_ago_hours — sets the instance/step created_at to N hours ago
 *                      (default 0 = unset = "just now")
 *   initiated_by     — defaults to approver_user_id
 */
export async function makeApprovalInstanceWithApprover(t, opts) {
  const status = opts.instance_status ?? "PENDING";
  const approverStatus = opts.approver_status ?? "PENDING";

  // Safely interpolate hours-ago intervals (only numbers allowed).
  const createdAgo = Number(opts.created_ago_hours);
  const actedAgo = Number(opts.acted_ago_hours);
  const createdExpr = Number.isFinite(createdAgo) && createdAgo > 0
    ? `NOW() - INTERVAL '${createdAgo} hours'`
    : "NOW()";
  const completedExpr = status === "APPROVED" && Number.isFinite(actedAgo) && actedAgo >= 0
    ? `NOW() - INTERVAL '${actedAgo} hours'`
    : "NULL";

  const inst = await t.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        initiated_by, hospitality_company_id, hotel_id, created_at, completed_at)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $7,
             ${createdExpr}, ${completedExpr})
     RETURNING id`,
    [
      opts.entity_type,
      opts.entity_id,
      opts.policy_id,
      status,
      opts.initiated_by ?? opts.approver_user_id,
      opts.hospitality,
      opts.hotel,
    ]
  );
  const step = await t.one(
    `INSERT INTO tbl_approval_instance_steps
       (approval_instance_id, step_order, status, decision_rule, completed_at)
     VALUES ($1, 1, $2, 'ANY', ${completedExpr})
     RETURNING id`,
    [inst.id, status === "PENDING" ? "PENDING" : status]
  );
  await t.none(
    `INSERT INTO tbl_approval_step_approvers
       (approval_instance_step_id, approver_user_id, status, acted_at)
     VALUES ($1, $2, $3, ${completedExpr})`,
    [step.id, opts.approver_user_id, approverStatus]
  );
  return { instance_id: inst.id, step_id: step.id };
}

/**
 * Clean approval instances by entity_id (entity_type-scoped).
 * Cascade-deletes via app FKs is not on every column; do explicit ordered cleanup.
 */
export async function cleanupApprovalInstances(db, entity_type, entity_ids) {
  if (!entity_ids || entity_ids.length === 0) return;
  await db.none(
    `DELETE FROM tbl_approval_step_approvers
     WHERE approval_instance_step_id IN (
       SELECT s.id FROM tbl_approval_instance_steps s
       JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
       WHERE i.entity_type = $1 AND i.entity_id = ANY($2)
     )`,
    [entity_type, entity_ids]
  );
  await db.none(
    `DELETE FROM tbl_approval_instance_steps
     WHERE approval_instance_id IN (
       SELECT id FROM tbl_approval_instances
       WHERE entity_type = $1 AND entity_id = ANY($2)
     )`,
    [entity_type, entity_ids]
  );
  await db.none(
    `DELETE FROM tbl_approval_instances
     WHERE entity_type = $1 AND entity_id = ANY($2)`,
    [entity_type, entity_ids]
  );
}

/**
 * Insert a PO + a single line item against an RFQ. Returns the PO id +
 * line item id so tests can attach approval instances or assert.
 *
 * Required opts:
 *   rfq_id            — tbl_rfq.id
 *   rfq_product_id    — tbl_rfq_products.id (must exist; use addProductToRfq)
 *   vendor_user_id    — tbl_users.id of finalized vendor
 *   company_id        — tbl_company.id (buyer parent — IDS.companies.A typically)
 *   initiated_by      — tbl_users.id (defaults to vendor_user_id)
 *
 * Optional opts:
 *   status            — po_status enum; default 'pending_approval'
 *   unit_price        — numeric; default 100
 *   quantity          — numeric; default 1
 *   total_value       — numeric; default unit_price * quantity
 *   created_ago_days  — int; sets created_at to N days ago for ordering tests
 */
export async function makePO(t, opts) {
  const unit = Number(opts.unit_price ?? 100);
  const qty = Number(opts.quantity ?? 1);
  const total = Number(opts.total_value ?? unit * qty);
  const status = opts.status ?? "pending_approval";
  const createdAgoDays = Number(opts.created_ago_days) || 0;
  const createdExpr = createdAgoDays > 0
    ? `NOW() - INTERVAL '${createdAgoDays} days'`
    : "NOW()";
  const poNumber =
    opts.po_number ??
    `PO-${opts.rfq_id}-${Math.floor(Math.random() * 1e6)}`;
  const po = await t.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, created_at)
     VALUES ($1, $2, $3, $4, ARRAY[$5]::int[], $6, $7, $8, $9, ARRAY[]::int[], $10,
             ${createdExpr})
     RETURNING id`,
    [
      opts.rfq_id,
      opts.company_id,
      poNumber,
      status,
      opts.rfq_product_id,
      qty,
      unit,
      opts.vendor_user_id,
      total,
      opts.initiated_by ?? opts.vendor_user_id,
    ]
  );
  // Insert one tbl_purchase_order_product line.
  const pop = await t.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
     VALUES ($1, $2, 0, $3, 'units', $4, $5)
     RETURNING id`,
    [po.id, opts.rfq_product_id, qty, unit, total]
  );
  return { po_id: po.id, pop_id: pop.id };
}

/**
 * Cleanup helper for POs and their line items.
 */
export async function cleanupPurchaseOrders(db, po_ids) {
  if (!po_ids || po_ids.length === 0) return;
  await db.none(
    `DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1)`,
    [po_ids]
  );
  await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1)`, [po_ids]);
}

/**
 * Insert a tbl_quotes row simulating a vendor that responded.
 * Used to flip RFQs from "no response" to "responded" in tests.
 */
export async function insertVendorQuote(t, { rfq_id, vendor_user_id, status = 1 }) {
  // tbl_quotes.rfq_no is NOT NULL — read it from the parent RFQ.
  const parent = await t.one(`SELECT rfq_no FROM tbl_rfq WHERE id = $1`, [rfq_id]);
  const row = await t.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
     VALUES ($1, $2, $3, $3, $4, now()) RETURNING id`,
    [rfq_id, parent.rfq_no, vendor_user_id, status]
  );
  return row.id;
}
