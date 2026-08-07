// MR call-off mediums (audit CO11 / CO12 / CO13).
//
//   CO12 — the contracted-items picker includes 'expiring_soon' contracts
//          (still live), not just 'active'.
//   CO13 — release refuses to mint a ₹0 PO when the resolved unit rate is ≤ 0.
//   CO11 — when a release fails (e.g. the over-consumption guard aborts), the
//          MR raiser is notified instead of the failure being swallowed.
//
// Product-level: real Express app + Postgres.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const HC = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const PROC = IDS.processes.A_P1;
const BUYER = IDS.users.a1_proc_buyer;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

describe("MR call-off mediums (CO11/CO12/CO13)", () => {
  let buyerClient, handleMrPostApproval, arcId;
  let cActive, lActive, cExpiring, lExpiring, cZero, lZero;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    buyerClient = await httpClient(BUYER);
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-P5-1','Phase5 ARC',$1,$2,$3,$4,$5,'contract_active',
               NOW()-INTERVAL '30 days', NOW()-INTERVAL '20 days',
               NOW()-INTERVAL '10 days', NOW()+INTERVAL '180 days', $6) RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]);
    arcId = arc.id;
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1,$2,1000,'litre') RETURNING *`, [arcId, VARIANT_ID]);

    cActive = (await db.one(`INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1,$2,'active') RETURNING *`, [arcId, IDS.users.vendor_alpha])).id;
    lActive = (await db.one(`INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty) VALUES ($1,$2,90,5,1000) RETURNING *`, [cActive, item.id])).id;

    cExpiring = (await db.one(`INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1,$2,'expiring_soon') RETURNING *`, [arcId, IDS.users.vendor_beta])).id;
    lExpiring = (await db.one(`INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty) VALUES ($1,$2,80,5,500) RETURNING *`, [cExpiring, item.id])).id;

    cZero = (await db.one(`INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1,$2,'active') RETURNING *`, [arcId, IDS.users.vendor_gamma])).id;
    lZero = (await db.one(`INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty) VALUES ($1,$2,0,5,100) RETURNING *`, [cZero, item.id])).id;

    ({ handleMrPostApproval } = await import("../../../app/controllers/mr/mrController.js"));
  });

  afterAll(async () => {
    const cs = [cActive, cExpiring, cZero];
    await db.none(`DELETE FROM tbl_notifications WHERE category IN ('CALL_OFF','mr')`);
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id IN (SELECT id FROM tbl_rfq_purchase_order WHERE arc_contract_id = ANY($1::int[]))`, [cs]);
    await db.none(`DELETE FROM tbl_arc_callof_po WHERE arc_contract_id = ANY($1::int[])`, [cs]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE arc_contract_id = ANY($1::int[])`, [cs]);
    await db.none(`DELETE FROM tbl_material_requisition_item WHERE arc_contract_id = ANY($1::int[])`, [cs]);
    await db.none(`DELETE FROM tbl_material_requisition WHERE hospitality_company_id=$1 AND title LIKE 'P5%'`, [HC]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id = ANY($1::int[])`, [cs]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id = ANY($1::int[])`, [cs]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [arcId]);
  });

  async function seedAndRelease(tag, contractId, lineId, qty, instId, preConsumed = 0) {
    await db.none(`UPDATE tbl_arc_contract_line SET consumed_qty=$2 WHERE id=$1`, [lineId, preConsumed]);
    const mr = await db.one(
      `INSERT INTO tbl_material_requisition
         (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, submitted_at)
       VALUES ($1,$2,$3,$4,$5,'normal',$6,'pending_approval',NOW()) RETURNING *`,
      [`MR-${tag}`, `P5 ${tag}`, HC, HOTEL, DEPT, BUYER]);
    await db.none(
      `INSERT INTO tbl_material_requisition_item
         (mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id, matched_unit_rate)
       VALUES ($1,$2,$3,'litre',$4,$5,90)`, [mr.id, VARIANT_ID, qty, contractId, lineId]);
    await handleMrPostApproval(instId, BUYER, {
      instance: { id: instId, entity_type: "MR", entity_id: mr.id, status: "APPROVED" },
    });
    return mr.id;
  }

  test("CO12 — the picker surfaces items from an 'expiring_soon' contract", async () => {
    const res = await buyerClient.get(`/api/v1/mr/search-contracted-items?hotel_id=${HOTEL}&department_id=${DEPT}`);
    expect(res.status).toBe(200);
    const hit = res.body.data.items.find((i) => i.arc_contract_line_id === lExpiring);
    expect(hit).toBeTruthy();
  });

  test("CO13 — release refuses a ₹0-rate line (no PO minted)", async () => {
    const mrId = await seedAndRelease("zero", cZero, lZero, 10, 70050);
    const pos = await db.any(`SELECT id FROM tbl_arc_callof_po WHERE mr_id=$1`, [mrId]);
    expect(pos.length).toBe(0);
    const mr = await db.one(`SELECT status FROM tbl_material_requisition WHERE id=$1`, [mrId]);
    expect(mr.status).not.toBe("po_released");
  });

  test("CO11 — a failed release (over-consumption) notifies the raiser instead of swallowing", async () => {
    // committed 1000, pre-consume 950 → a 200-qty release exceeds remaining (50).
    const mrId = await seedAndRelease("fail", cActive, lActive, 200, 70051, 950);
    const mr = await db.one(`SELECT status FROM tbl_material_requisition WHERE id=$1`, [mrId]);
    expect(mr.status).not.toBe("po_released"); // release aborted
    const notif = await db.oneOrNone(
      `SELECT id FROM tbl_notifications
        WHERE recipient_user_id = $1 AND type = 'CALL_OFF_RELEASE_FAILED'
          AND additional_data->>'mr_id' = $2`,
      [BUYER, String(mrId)]
    );
    expect(notif).toBeTruthy();
  });
});
