// Call-off vendor acceptance lifecycle + release notification (CO6, CO9, CO10).
//
//   - Call-off PO is born 'acceptance_pending' (not auto-approved).
//   - On release, the vendor + the MR raiser get an in-app notification.
//   - Vendor ACCEPT → 'approved'.
//   - Vendor REJECT → 'rejected_by_vendor' + consumed_qty reversed + MR reopened.
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
const VENDOR = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

describe("Call-off vendor acceptance + notification (CO6/CO9/CO10)", () => {
  let vendorClient, arcId, contractId, contractLineId, handleMrPostApproval;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);
    vendorClient = await httpClient(VENDOR);
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-COACC-1','Call-off acceptance ARC',$1,$2,$3,$4,$5,'contract_active',
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
    await db.none(`DELETE FROM tbl_notifications WHERE category='CALL_OFF'`);
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id IN (SELECT id FROM tbl_rfq_purchase_order WHERE arc_contract_id=$1)`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_callof_po WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_material_requisition_item WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_material_requisition WHERE hospitality_company_id=$1 AND title LIKE 'COACC%'`, [HC]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [arcId]);
  });

  // Release a call-off PO for a fresh MR; returns { mrId, poId }.
  async function releaseOne(tag, qty, instId) {
    await db.none(`UPDATE tbl_arc_contract_line SET consumed_qty=0 WHERE id=$1`, [contractLineId]);
    const mr = await db.one(
      `INSERT INTO tbl_material_requisition
         (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, submitted_at)
       VALUES ($1,$2,$3,$4,$5,'normal',$6,'pending_approval',NOW()) RETURNING *`,
      [`MR-${tag}`, `COACC ${tag}`, HC, HOTEL, DEPT, BUYER]);
    await db.none(
      `INSERT INTO tbl_material_requisition_item
         (mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id, matched_unit_rate)
       VALUES ($1,$2,$3,'litre',$4,$5,90)`, [mr.id, VARIANT_ID, qty, contractId, contractLineId]);
    await handleMrPostApproval(instId, BUYER, {
      instance: { id: instId, entity_type: "MR", entity_id: mr.id, status: "APPROVED" },
    });
    const poId = (await db.one(`SELECT po_id FROM tbl_arc_callof_po WHERE mr_id=$1`, [mr.id])).po_id;
    return { mrId: mr.id, poId };
  }

  test("CO6 — a released call-off PO is born 'acceptance_pending'", async () => {
    const { poId } = await releaseOne("born", 100, 70030);
    const po = await db.one(`SELECT status FROM tbl_rfq_purchase_order WHERE id=$1`, [poId]);
    expect(po.status).toBe("acceptance_pending");
  });

  test("CO10 — release notifies the vendor and the raiser", async () => {
    const { poId } = await releaseOne("notify", 100, 70031);
    const recips = (await db.any(
      `SELECT recipient_user_id FROM tbl_notifications WHERE additional_data->>'po_id' = $1`, [String(poId)]
    )).map(r => Number(r.recipient_user_id));
    expect(recips).toContain(VENDOR);
    expect(recips).toContain(BUYER);
  });

  test("CO6 — the assigned vendor can ACCEPT the call-off PO → 'approved'", async () => {
    const { poId } = await releaseOne("accept", 100, 70032);
    const res = await vendorClient.post(`/api/v1/po/accept/${poId}`).send({});
    expect(res.status).toBe(200);
    const po = await db.one(`SELECT status FROM tbl_rfq_purchase_order WHERE id=$1`, [poId]);
    expect(po.status).toBe("approved");
  });

  test("CO9 — vendor REJECT reverses consumption + reopens the MR", async () => {
    const { mrId, poId } = await releaseOne("reject", 150, 70033);
    const consumedAfterRelease = Number((await db.one(`SELECT consumed_qty FROM tbl_arc_contract_line WHERE id=$1`, [contractLineId])).consumed_qty);
    expect(consumedAfterRelease).toBe(150); // reserved on release

    const res = await vendorClient.post(`/api/v1/po/reject/${poId}`).send({ reason: "Cannot supply" });
    expect(res.status).toBe(200);

    const po = await db.one(`SELECT status FROM tbl_rfq_purchase_order WHERE id=$1`, [poId]);
    expect(po.status).toBe("rejected_by_vendor");
    const consumedAfterReject = Number((await db.one(`SELECT consumed_qty FROM tbl_arc_contract_line WHERE id=$1`, [contractLineId])).consumed_qty);
    expect(consumedAfterReject).toBe(0); // reversed
    const mr = await db.one(`SELECT status FROM tbl_material_requisition WHERE id=$1`, [mrId]);
    expect(mr.status).toBe("approved"); // reopened

    // CO9 — the MR raiser (buyer) is notified of the rejection.
    const notif = await db.oneOrNone(
      `SELECT id FROM tbl_notifications
        WHERE recipient_user_id = $1 AND type = 'CALL_OFF_REJECTED'
          AND additional_data->>'po_number' = (SELECT po_number FROM tbl_rfq_purchase_order WHERE id = $2)`,
      [BUYER, poId]
    );
    expect(notif).toBeTruthy();
  });
});
