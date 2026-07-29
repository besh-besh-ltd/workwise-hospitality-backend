// Call-off release — idempotency + atomic over-consumption guard (CO3, CO4).
//
//   CO3 — firing the MR post-approval hook twice must release the call-off
//         EXACTLY ONCE (no duplicate PO, no double consumption).
//   CO4 — release must never push consumed_qty past committed_qty, even if the
//         remaining qty shrank between submit and release (concurrent draw).
//
// Product-level: real Express app + Postgres. Drives the hook directly (the
// approval engine's terminal-APPROVED dispatch), mirroring mr.flow.test.js.

import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const HC = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const PROC = IDS.processes.A_P1;
const BUYER = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

describe("Call-off release guards (CO3 idempotency · CO4 over-consumption)", () => {
  let arcId, contractId, contractLineId, handleMrPostApproval;

  beforeAll(async () => {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-RELGUARD-1','Release guard ARC',$1,$2,$3,$4,$5,'contract_active',
               NOW()-INTERVAL '30 days', NOW()-INTERVAL '20 days',
               NOW()-INTERVAL '10 days', NOW()+INTERVAL '180 days', $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]);
    arcId = arc.id;
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1,$2,1000,'litre') RETURNING *`, [arcId, VARIANT_ID]);
    const contract = await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1,$2,'active') RETURNING *`,
      [arcId, VENDOR]);
    contractId = contract.id;
    const line = await db.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1,$2,90,5,1000) RETURNING *`, [contractId, item.id]);
    contractLineId = line.id;
    ({ handleMrPostApproval } = await import("../../../app/controllers/mr/mrController.js"));
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_arc_callof_po WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_material_requisition_item WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_material_requisition WHERE hospitality_company_id=$1 AND title LIKE 'RELGUARD%'`, [HC]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [arcId]);
  });

  async function seedPendingMr(title, qty) {
    const mr = await db.one(
      `INSERT INTO tbl_material_requisition
         (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, submitted_at)
       VALUES ($1,$2,$3,$4,$5,'normal',$6,'pending_approval',NOW()) RETURNING *`,
      [`MR-${title}-${qty}`, title, HC, HOTEL, DEPT, BUYER]);
    await db.none(
      `INSERT INTO tbl_material_requisition_item
         (mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id, matched_unit_rate)
       VALUES ($1,$2,$3,'litre',$4,$5,90)`, [mr.id, VARIANT_ID, qty, contractId, contractLineId]);
    return mr.id;
  }
  const consumed = async () =>
    Number((await db.one(`SELECT consumed_qty FROM tbl_arc_contract_line WHERE id=$1`, [contractLineId])).consumed_qty);

  test("CO3 — firing the post-approval hook twice releases the call-off only once", async () => {
    await db.none(`UPDATE tbl_arc_contract_line SET consumed_qty=0 WHERE id=$1`, [contractLineId]);
    const mrId = await seedPendingMr("RELGUARD-idem", 150);
    const before = await consumed();
    const inst = { id: 70010, entity_type: "MR", entity_id: mrId, status: "APPROVED" };
    await handleMrPostApproval(70010, BUYER, { instance: inst });
    await handleMrPostApproval(70010, BUYER, { instance: inst }); // double fire

    const pos = await db.any(`SELECT id FROM tbl_arc_callof_po WHERE mr_id=$1`, [mrId]);
    expect(pos.length).toBe(1);
    expect((await consumed()) - before).toBe(150); // incremented once, not twice
    const mr = await db.one(`SELECT status FROM tbl_material_requisition WHERE id=$1`, [mrId]);
    expect(mr.status).toBe("po_released");
  });

  test("CO4 — release will not push consumed_qty past committed_qty", async () => {
    await db.none(`UPDATE tbl_arc_contract_line SET consumed_qty=0 WHERE id=$1`, [contractLineId]);
    const mrId = await seedPendingMr("RELGUARD-over", 800); // committed 1000
    // Simulate a concurrent draw that consumed 900 between submit and release,
    // leaving only 100 remaining (< 800).
    await db.none(`UPDATE tbl_arc_contract_line SET consumed_qty=900 WHERE id=$1`, [contractLineId]);

    await handleMrPostApproval(70011, BUYER, {
      instance: { id: 70011, entity_type: "MR", entity_id: mrId, status: "APPROVED" },
    });

    // Consumption must NOT exceed committed (1000); the over-draw is refused.
    expect(await consumed()).toBeLessThanOrEqual(1000);
    expect(await consumed()).toBe(900); // unchanged — release blocked
    const pos = await db.any(`SELECT id FROM tbl_arc_callof_po WHERE mr_id=$1`, [mrId]);
    expect(pos.length).toBe(0);
    const mr = await db.one(`SELECT status FROM tbl_material_requisition WHERE id=$1`, [mrId]);
    expect(mr.status).not.toBe("po_released");
  });
});
