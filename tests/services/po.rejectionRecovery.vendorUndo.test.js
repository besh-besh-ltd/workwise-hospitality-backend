// REQ-0032 — vendor undo: "Rejected by mistake? Accept this order instead."
//
// A vendor can take a PO rejection back for 24 hours, while nothing the
// rejection freed has moved on. One action restores the award and accepts the
// PO (status approved) with the same lifecycle row a normal accept writes, plus
// a "rejection withdrawn" row and a notice to the buyer's team.
//
// Every case starts from a REAL rejection through the production rejectPO
// handler. The 24-hour test moves vendor_action_at back with SQL; time is
// never mocked. Run under the default and PGOPTIONS="-c timezone=UTC".

import {
  describe, it, expect, afterAll, beforeAll, afterEach,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import {
  installPostCommitTracking, drainPostCommitWork, deleteNotificationsFor, mockExpress,
  recoveryFixtures, trackedCalls, resetTrackedCalls,
} from "../helpers/poRecoveryFixtures.js";

// Post-commit work is tracked by the shared helper; install before the app loads.
await installPostCommitTracking();

const ALPHA = IDS.users.vendor_alpha;
const BETA = IDS.users.vendor_beta;
const BUYER = IDS.users.a1_proc_buyer;

afterAll(async () => {
  await drainPostCommitWork();
  await closeDb();
});

const fx = recoveryFixtures();
const { makeFinalization, addQuote, awardedPo, vendorRejects, rejectedPo } = fx;
afterEach(fx.cleanup);

const readPo = (po_id) => db.one(`SELECT * FROM tbl_rfq_purchase_order WHERE id = $1`, [po_id]);

const undo = await import("../../app/controllers/po/poRejectionRecoveryController.js");
const { lookupEvent } = await import("../../app/services/activity/eventRegistry.js");
const { httpClient } = await import("../helpers/http.js");

async function call(handler, po_id, userId = ALPHA) {
  const m = mockExpress({ user: { id: userId }, params: { po_id: String(po_id) } });
  await handler(m.req, m.res);
  return { status: m.calls.status ?? 200, body: m.calls.body };
}
const withdraw = (po_id, userId) => call(undo.withdrawRejection, po_id, userId);
const getState = (po_id, userId) => call(undo.getRejectionUndoState, po_id, userId);
const lifecycle = (po_id) => db.any(
  `SELECT stage, action, performed_by, metadata FROM tbl_lifecycle_history
    WHERE entity_type = 'PO' AND entity_id = $1 ORDER BY id`, [po_id]);
const nqStatus = async (id) =>
  (await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [id])).status;
const live = (rfq_id) => db.any(
  `SELECT vendor_id FROM tbl_quote_finalization WHERE rfq_id = $1`, [rfq_id]);

describe("vendor undo — RFQ PO", () => {
  it("GET undo state is available with a deadline right after rejecting", async () => {
    const s = await rejectedPo();
    const { status, body } = await getState(s.po_id);
    expect(status).toBe(200);
    expect(body.status).toBe(1);
    expect(body.data).toMatchObject({ available: true, blockers: [] });
    const deadline = new Date(body.data.deadline).getTime();
    expect(body.data.deadline).toMatch(/Z$/);
    expect(Math.abs(deadline - (Date.now() + 24 * 3600_000))).toBeLessThan(120_000);
  });

  it("withdraw restores the award, sets approved, clears the reason and writes both lifecycle rows", async () => {
    const s = await rejectedPo();
    expect(await live(s.rfq_id)).toEqual([]);
    const rejectedAt = (await readPo(s.po_id)).vendor_action_at;
    await new Promise((r) => setTimeout(r, 15));

    const { status, body } = await withdraw(s.po_id);
    expect(status).toBe(200);
    expect(body).toEqual({ status: 1, message: "Rejection withdrawn. The purchase order is accepted." });

    const po = await readPo(s.po_id);
    expect(po.status).toBe("approved");
    expect(po.vendor_rejection_reason).toBeNull();
    expect(po.vendor_action_at.getTime()).toBeGreaterThan(rejectedAt.getTime());
    expect(await live(s.rfq_id)).toEqual([{ vendor_id: ALPHA }]);
    expect(await nqStatus(s.nqIds[0])).toBe("APPROVED");

    const rows = (await lifecycle(s.po_id)).filter((r) => r.stage !== "PO_REJECTED_BY_VENDOR");
    expect(rows.map((r) => [r.stage, r.action, r.performed_by])).toEqual([
      ["PO_REJECTION_WITHDRAWN", "WITHDRAW_REJECTION", ALPHA],
      ["PO_ACCEPTED_BY_VENDOR", "ACCEPT", ALPHA],
    ]);
    expect(rows[0].metadata).toMatchObject({
      rfq_id: s.rfq_id, po_number: po.po_number, previous_rejection_reason: "Ordered the wrong item",
    });
    expect(new Date(rows[0].metadata.previous_rejected_at).getTime()).toBe(rejectedAt.getTime());
    expect(rows[1].metadata).toMatchObject({ rfq_id: s.rfq_id, po_number: po.po_number });
  });

  it("withdraw notifies the commercial evaluators", async () => {
    const s = await rejectedPo();
    await drainPostCommitWork();
    const noticeFor = (type) => db.any(
      `SELECT recipient_user_id, title, message, category, action_url FROM tbl_notifications
        WHERE type = $1 AND (additional_data->>'po_id') = $2 ORDER BY recipient_user_id`,
      [type, String(s.po_id)]);
    const rejection = await noticeFor("po_vendor_rejected");
    expect(rejection.length).toBeGreaterThan(0);

    resetTrackedCalls();
    await withdraw(s.po_id);
    await drainPostCommitWork();

    const withdrawn = await noticeFor("po_vendor_rejection_withdrawn");
    // Same people the rejection told.
    expect(withdrawn.map((n) => n.recipient_user_id))
      .toEqual(rejection.map((n) => n.recipient_user_id));
    for (const n of withdrawn) {
      expect(n.title).toBe("Vendor withdrew their rejection");
      expect(n.message).toMatch(/withdrew their rejection of PO #TEST-PO-\d+ and accepted it\.$/);
      expect(n.category).toBe("po");
      expect(n.action_url).toBe(`/dashboard/buyer/purchase-orders/${s.po_id}`);
    }
    // The two mails a normal accept sends also went out.
    expect(trackedCalls("sendPONotificationToVendor")).toHaveLength(1);
    expect(trackedCalls("sendPOAcceptedNotificationToTeam")).toHaveLength(1);
  });

  it("withdraw after 24h is refused 409 UNDO_WINDOW_EXPIRED and changes nothing", async () => {
    const s = await rejectedPo();
    await db.none(
      `UPDATE tbl_rfq_purchase_order SET vendor_action_at = NOW() - interval '25 hours' WHERE id = $1`, [s.po_id]);

    const state = await getState(s.po_id);
    expect(state.body.data).toMatchObject({ available: false, blockers: ["UNDO_WINDOW_EXPIRED"] });

    const { status, body } = await withdraw(s.po_id);
    expect(status).toBe(409);
    expect(body).toMatchObject({ status: 0, code: "UNDO_WINDOW_EXPIRED" });
    expect((await readPo(s.po_id)).status).toBe("rejected_by_vendor");
    expect(await live(s.rfq_id)).toEqual([]);
    expect((await lifecycle(s.po_id)).map((r) => r.stage)).toEqual(["PO_REJECTED_BY_VENDOR"]);
  });

  it("withdraw is refused 409 PRODUCT_REAWARDED after the buyer finalized someone else", async () => {
    const s = await rejectedPo();
    const q = await addQuote(s.rfq_id, BETA);
    await makeFinalization(s.rfq_id, s.product_variant_id, BETA, q);

    const state = await getState(s.po_id);
    expect(state.body.data).toMatchObject({ available: false });
    expect(state.body.data.blockers).toContain("PRODUCT_REAWARDED");

    const { status, body } = await withdraw(s.po_id);
    expect(status).toBe(409);
    expect(body).toMatchObject({ status: 0, code: "PRODUCT_REAWARDED" });
    expect(body.message).toMatch(/given to a vendor/);
    expect((await readPo(s.po_id)).status).toBe("rejected_by_vendor");
    expect(await live(s.rfq_id)).toEqual([{ vendor_id: BETA }]);
  });

  it("another vendor gets 403; unknown PO 404", async () => {
    const s = await rejectedPo();
    for (const fn of [withdraw, getState]) {
      const other = await fn(s.po_id, BETA);
      expect(other.status).toBe(403);
      expect(other.body).toMatchObject({ status: 0, code: "NOT_YOUR_PO" });
      const none = await fn(999999999, ALPHA);
      expect(none.status).toBe(404);
      expect(none.body).toMatchObject({ status: 0, code: "NOT_FOUND" });
    }
    expect((await readPo(s.po_id)).status).toBe("rejected_by_vendor");
  });

  it("a buyer token cannot call the vendor route", async () => {
    const s = await rejectedPo();
    const client = await httpClient(BUYER);
    const post = await client.post(`/api/v1/po/vendor/${s.po_id}/withdraw-rejection`).send({});
    expect(post.status).toBe(403);
    const get = await client.get(`/api/v1/po/vendor/${s.po_id}/rejection-undo`);
    expect(get.status).toBe(403);
    expect((await readPo(s.po_id)).status).toBe("rejected_by_vendor");
  });

  it("second withdraw returns 409 NOT_REJECTED_BY_VENDOR", async () => {
    const s = await rejectedPo();
    expect((await withdraw(s.po_id)).status).toBe(200);
    const again = await withdraw(s.po_id);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ status: 0, code: "NOT_REJECTED_BY_VENDOR" });
    const state = await getState(s.po_id);
    expect(state.body.data).toMatchObject({ available: false, deadline: null, blockers: ["NOT_REJECTED_BY_VENDOR"] });
  });

  it("two simultaneous withdraws: exactly one succeeds", async () => {
    const s = await rejectedPo();
    const r = await Promise.all([withdraw(s.po_id), withdraw(s.po_id)]);
    expect(r.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(r.find((x) => x.status === 409).body.code).toBe("NOT_REJECTED_BY_VENDOR");
    expect(await live(s.rfq_id)).toHaveLength(1);
  });
});

describe("activity registry", () => {
  it("activity registry maps the withdraw route", () => {
    const ev = lookupEvent("POST", "/po/vendor/:po_id/withdraw-rejection");
    expect(ev).toMatchObject({ key: "po_rejection_withdrawn", severity: "critical" });
    expect(ev.summary({ actor: "Asha", entityLabel: "PO-9" }))
      .toBe("Asha withdrew their rejection and accepted purchase order PO-9");
  });
});

describe("vendor undo — call-off PO", () => {
  const HC = IDS.hospitality.A;
  const HOTEL = IDS.hotels.A1;
  const DEPT = IDS.departments.proc;
  const PROC = IDS.processes.A_P1;
  let arcId, contractId, contractLineId, handleMrPostApproval;

  beforeAll(async () => {
    arcId = (await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-B2UNDO-1','Vendor undo ARC',$1,$2,$3,$4,$5,'contract_active',
               NOW()-INTERVAL '30 days', NOW()-INTERVAL '20 days',
               NOW()-INTERVAL '10 days', NOW()+INTERVAL '180 days', $6) RETURNING id`,
      [TEST_CATEGORIES.beverages, HC, HOTEL, DEPT, PROC, BUYER]
    )).id;
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1,1,1000,'litre') RETURNING id`, [arcId]);
    contractId = (await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1,$2,'active') RETURNING id`,
      [arcId, ALPHA])).id;
    contractLineId = (await db.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1,$2,90,5,1000) RETURNING id`, [contractId, item.id])).id;
    await db.none(
      `INSERT INTO tbl_arc_contract_line_hotel (arc_contract_line_id, hotel_id, committed_qty)
       VALUES ($1, $2, 1000)`, [contractLineId, HOTEL]);
    ({ handleMrPostApproval } = await import("../../app/controllers/mr/mrController.js"));
  });

  afterAll(async () => {
    await drainPostCommitWork();
    const poIds = (await db.any(
      `SELECT id FROM tbl_rfq_purchase_order WHERE arc_contract_id = $1`, [contractId])).map((r) => r.id);
    const mrIds = (await db.any(
      `SELECT id FROM tbl_material_requisition WHERE hospitality_company_id = $1 AND title LIKE 'B2UNDO%'`, [HC])).map((r) => r.id);
    await deleteNotificationsFor({ poIds, mrIds });
    if (poIds.length) {
      await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type = 'PO' AND entity_id = ANY($1::int[])`, [poIds]);
    }
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id IN (SELECT id FROM tbl_rfq_purchase_order WHERE arc_contract_id=$1)`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_callof_po WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_material_requisition_item WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_material_requisition WHERE hospitality_company_id=$1 AND title LIKE 'B2UNDO%'`, [HC]);
    await db.none(`DELETE FROM tbl_arc_contract_line_hotel WHERE arc_contract_line_id=$1`, [contractLineId]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [arcId]);
  });

  const consumed = async () => Number((await db.one(
    `SELECT consumed_qty FROM tbl_arc_contract_line WHERE id=$1`, [contractLineId])).consumed_qty);

  it("call-off withdraw re-reserves quantity and tells the MR raiser", async () => {
    const mr = await db.one(
      `INSERT INTO tbl_material_requisition
         (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, submitted_at)
       VALUES ('MR-B2UNDO-1','B2UNDO 1',$1,$2,$3,'normal',$4,'pending_approval',NOW()) RETURNING id`,
      [HC, HOTEL, DEPT, BUYER]);
    await db.none(
      `INSERT INTO tbl_material_requisition_item
         (mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id, matched_unit_rate)
       VALUES ($1,1,150,'litre',$2,$3,90)`, [mr.id, contractId, contractLineId]);
    await handleMrPostApproval(72001, BUYER, {
      instance: { id: 72001, entity_type: "MR", entity_id: mr.id, status: "APPROVED" },
    });
    const poId = (await db.one(`SELECT po_id FROM tbl_arc_callof_po WHERE mr_id=$1`, [mr.id])).po_id;
    expect(await consumed()).toBe(150);

    await vendorRejects(poId, ALPHA, "Cannot supply");
    expect(await consumed()).toBe(0);

    const { status, body } = await withdraw(poId);
    expect(status).toBe(200);
    expect(body.status).toBe(1);
    await drainPostCommitWork();

    expect(await consumed()).toBe(150);
    expect((await readPo(poId)).status).toBe("approved");
    expect((await db.one(`SELECT status FROM tbl_material_requisition WHERE id=$1`, [mr.id])).status).toBe("po_released");
    const n = await db.one(
      `SELECT recipient_user_id, message FROM tbl_notifications
        WHERE type = 'CALL_OFF_REJECTION_WITHDRAWN' AND (additional_data->>'mr_id') = $1`, [String(mr.id)]);
    expect(Number(n.recipient_user_id)).toBe(BUYER);
    expect(n.message).toMatch(/withdrew their rejection of call-off PO .+ and accepted it\. The contract quantity is reserved again\.$/);
  });
});
