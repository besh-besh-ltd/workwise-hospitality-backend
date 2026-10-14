/**
 * A NON-PR approval decided through the generic engine endpoint
 * (POST /general/hospitality/approval/action) is recorded in the trail with the
 * label, company and hotel taken from the INSTANCE row (and the entity it
 * points at) — not from anything PR-specific. The PR case lives in
 * activity.pr.test.js; this pins that the APPROVAL_INSTANCE resolver still
 * serves the other entity types.
 *
 * Pattern B: real HTTP, capture writes on its own connection after `finish`.
 */
import { describe, it, expect, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";

const APPROVER = IDS.users.a1_proc_poApp;
const created = { rfqIds: [], instIds: [], poIds: [], productIds: [], quoteIds: [] };

const waitForEvent = async (since, instId, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db.oneOrNone(
      `SELECT event_key, entity_type, entity_id::int AS entity_id, entity_label, hospitality_company_id, hotel_id,
              actor_user_id, summary
         FROM tbl_activity_events
        WHERE occurred_at >= $1 AND event_key = 'approval_decided' AND entity_type = 'APPROVAL_INSTANCE' AND entity_id = $2
        ORDER BY id DESC LIMIT 1`,
      [since, instId]
    );
    if (row) return row;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
};

afterAll(async () => {
  if (created.poIds.length) await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1)`, [created.poIds]);
  if (created.instIds.length) {
    await db.none(`DELETE FROM tbl_activity_events WHERE entity_type = 'APPROVAL_INSTANCE' AND entity_id = ANY($1)`, [created.instIds]);
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1)`, [created.instIds]);
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
         (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1))`, [created.instIds]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1)`, [created.instIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1)`, [created.instIds]);
  }
  if (created.quoteIds.length) await db.none(`DELETE FROM tbl_quotes WHERE id = ANY($1)`, [created.quoteIds]);
  if (created.productIds.length) await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1)`, [created.productIds]);
  if (created.rfqIds.length) await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1)`, [created.rfqIds]);
  await closeDb();
});

describe("activity trail — non-PR approval through the generic engine", () => {
  it("a PO approval decision is labelled 'PO <number>' and scoped to the instance's company and hotel", async () => {
    const variant = await db.one(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 1`);
    const { rfq_id, rfq_no } = await makeRFQ(db, {
      createdBy: IDS.users.a1_proc_buyer, status: 1, is_published: 1,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      department: IDS.departments.proc, process: IDS.processes.A_P1,
    });
    created.rfqIds.push(rfq_id);
    const product = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, 'Spec', '', '', '', '', $2, 0) RETURNING id`, [rfq_id, variant.id]);
    created.productIds.push(product.id);
    const quote = await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id`,
      [rfq_id, rfq_no, IDS.users.vendor_alpha]);
    created.quoteIds.push(quote.id);
    const poNumber = `NPA-${process.pid}`;
    const inst = await db.one(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, approval_policy_id, status, current_step,
          hospitality_company_id, hotel_id, department_id, initiated_by, process_id)
       VALUES ('PO', 0, $1, 'PENDING', 1, $2, $3, $4, $5, $6) RETURNING id`,
      [IDS.policies.A1_P1_PO, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc,
       IDS.users.a1_proc_buyer, IDS.processes.A_P1]);
    created.instIds.push(inst.id);
    const po = await db.one(
      `INSERT INTO tbl_rfq_purchase_order
         (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
          finalized_vendor_id, total_value, quote_id, initiated_by, approval_instance_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'pending_approval', $4, 1, 100, $5, 100, $6, $7, $8, NOW(), NOW()) RETURNING id`,
      [rfq_id, IDS.companies.A, poNumber, [product.id], IDS.users.vendor_alpha, [quote.id],
       IDS.users.a1_proc_buyer, inst.id]);
    created.poIds.push(po.id);
    await db.none(`UPDATE tbl_approval_instances SET entity_id = $1 WHERE id = $2`, [po.id, inst.id]);
    const step = await db.one(
      `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
       VALUES ($1, 1, 'ANY', 'PENDING') RETURNING id`, [inst.id]);
    await db.none(
      `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
       VALUES ($1, $2, 'PENDING')`, [step.id, APPROVER]);

    const since = new Date();
    const res = await (await httpClient(APPROVER))
      .post("/api/v1/general/hospitality/approval/action")
      .send({ approval_instance_id: inst.id, action: "REJECT", comment: "no" });
    expect(res.status).toBe(200);

    const e = await waitForEvent(since, inst.id);
    expect(e).not.toBeNull();
    expect(e).toMatchObject({
      entity_label: `PO ${poNumber}`,
      hospitality_company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A1,
      actor_user_id: APPROVER,
    });
    expect(e.summary).toMatch(/rejected PO /);
  });
});
