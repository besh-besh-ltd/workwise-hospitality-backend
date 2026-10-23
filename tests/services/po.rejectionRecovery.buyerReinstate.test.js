// REQ-0032 — buyer send-back: "Send back to vendor".
//
// A buyer with quote-compare.create (RFQ PO) or mr.create (call-off PO) can
// return a vendor-rejected PO to the SAME vendor for acceptance, with a required
// internal note and no new approval. Every case starts from a REAL rejection
// through the production rejectPO handler. Time is never mocked. Run under the
// default and PGOPTIONS="-c timezone=Asia/Kolkata" (and UTC).

import {
  describe, it, expect, afterAll, beforeAll, afterEach, beforeEach,
} from "@jest/globals";
import nodemailer from "nodemailer";
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
const EVALUATOR = IDS.users.companyA_admin; // quote-compare.create + rfq.read at hospitality A
const NO_QC = IDS.users.a1_proc_buyer;      // rfq.read only: can see the PO, cannot send it back
const OTHER_TENANT = IDS.users.companyB_admin;
const DAY = 24 * 3600_000;
const NOTE = "Vendor confirmed by phone it was a mis-click — INTERNAL-NOTE-7731";

const fx = recoveryFixtures();
const { makeFinalization, addQuote, awardedPo, vendorRejects, rejectedPo } = fx;

const sentMail = [];
let realTransport;
beforeAll(() => {
  realTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail(mail, cb) {
      sentMail.push(mail);
      const info = { messageId: "<reinstate>", response: "250 OK" };
      if (typeof cb === "function") cb(null, info);
      return Promise.resolve(info);
    },
    verify: () => Promise.resolve(true),
    close() {},
  });
});
beforeEach(() => { sentMail.length = 0; resetTrackedCalls(); });
afterEach(fx.cleanup);
afterAll(async () => {
  nodemailer.createTransport = realTransport;
  await drainPostCommitWork();
  await closeDb();
});

const ctrl = await import("../../app/controllers/po/poRejectionRecoveryController.js");
const vendorUndo = ctrl; // withdrawRejection lives in the same controller
const poController = await import("../../app/controllers/po/purchaseOrderController.js");
const { lookupEvent } = await import("../../app/services/activity/eventRegistry.js");
const { httpClient } = await import("../helpers/http.js");
const rfqModel = (await import("../../app/models/rfqModel.js")).default;
const { findPosNeedingVendorReminder } = await import("../../app/helper/cronManager.js");

// Let the rejection's own post-commit mails and notices land before the case
// starts recording, so they cannot be mistaken for the send-back's.
const settle = async () => { await drainPostCommitWork(); await new Promise((r) => setTimeout(r, 80)); };

const readPo = (po_id) => db.one(`SELECT * FROM tbl_rfq_purchase_order WHERE id = $1`, [po_id]);
const live = (rfq_id) => db.any(`SELECT vendor_id FROM tbl_quote_finalization WHERE rfq_id = $1`, [rfq_id]);
const nqStatus = async (id) => (await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [id])).status;
const lifecycle = (po_id) => db.any(
  `SELECT stage, action, performed_by, remarks, metadata FROM tbl_lifecycle_history
    WHERE entity_type = 'PO' AND entity_id = $1 ORDER BY id`, [po_id]);

async function call(handler, po_id, userId = EVALUATOR, body = {}) {
  const m = mockExpress({ user: { id: userId, user_type: 2 }, params: { po_id: String(po_id) }, body });
  await handler(m.req, m.res);
  return { status: m.calls.status ?? 200, body: m.calls.body };
}
const getState = (po_id, userId) => call(ctrl.getReinstate, po_id, userId);
const reinstate = (po_id, note = NOTE, userId) => call(ctrl.reinstate, po_id, userId, { note });
const reinstateNoNote = (po_id) => call(ctrl.reinstate, po_id, EVALUATOR, {});

describe("buyer send-back — RFQ PO", () => {
  it("evaluator with quote-compare.create sees available:true and the vendor's reason", async () => {
    const s = await rejectedPo();
    const { status, body } = await getState(s.po_id);
    expect(status).toBe(200);
    expect(body.status).toBe(1);
    expect(body.data).toMatchObject({ permitted: true, available: true, blockers: [] });
    expect(body.data.rejection.reason).toBe("Ordered the wrong item");
    expect(body.data.rejection.vendor_name).toBeTruthy();
    expect(body.data.rejection.rejected_at).toMatch(/Z$/);
  });

  it("a user who can see the PO but lacks quote-compare.create gets permitted:false, available:false", async () => {
    const s = await rejectedPo();
    const { status, body } = await getState(s.po_id, NO_QC);
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ permitted: false, available: false, blockers: [] });
  });

  it("reinstate returns the same PO to acceptance_pending with reminders reset, reason cleared, award restored", async () => {
    const s = await rejectedPo();
    await db.none(`UPDATE tbl_rfq_purchase_order SET vendor_reminder_count = 2 WHERE id = $1`, [s.po_id]);
    const before = await readPo(s.po_id);
    expect(await live(s.rfq_id)).toEqual([]);

    const { status, body } = await reinstate(s.po_id);
    expect(status).toBe(200);
    expect(body).toEqual({ status: 1, message: "Sent back to the vendor for acceptance." });

    const po = await readPo(s.po_id);
    expect(po).toMatchObject({
      status: "acceptance_pending", vendor_rejection_reason: null, vendor_action_at: null,
      vendor_reminder_count: 0, po_number: before.po_number, finalized_vendor_id: ALPHA,
    });
    expect(Number(po.total_value)).toBe(Number(before.total_value));
    expect((await live(s.rfq_id)).map((r) => r.vendor_id)).toEqual([ALPHA]);
    expect(await nqStatus(s.nqIds[0])).toBe("APPROVED");

    const row = (await lifecycle(s.po_id)).find((r) => r.stage === "PO_SENT_BACK_TO_VENDOR");
    expect(row).toMatchObject({ action: "REINSTATE", performed_by: EVALUATOR, remarks: NOTE });
    expect(row.metadata).toMatchObject({
      rfq_id: s.rfq_id, po_number: before.po_number, previous_rejection_reason: "Ordered the wrong item",
    });
    expect(row.metadata.previous_rejected_at).toBeTruthy();
  });

  it("the reminder cron picks the reinstated PO up again from day 1", async () => {
    const s = await rejectedPo();
    await db.none(`UPDATE tbl_rfq_purchase_order SET vendor_reminder_count = 2 WHERE id = $1`, [s.po_id]);
    expect((await reinstate(s.po_id)).status).toBe(200);

    // Just sent back: nothing due yet.
    expect((await findPosNeedingVendorReminder(new Date())).find((r) => r.id === s.po_id)).toBeUndefined();
    // A day and a bit later it is due the gentle day-1 reminder, not the day-5 final one.
    const updatedAt = (await readPo(s.po_id)).updated_at;
    const due = (await findPosNeedingVendorReminder(new Date(new Date(updatedAt).getTime() + DAY + 60_000)))
      .find((r) => r.id === s.po_id);
    expect(due).toMatchObject({ reminder_to_send: 1 });
  });

  it("vendor receives the acceptance request; the internal note never reaches the vendor", async () => {
    const s = await rejectedPo();
    await settle();
    resetTrackedCalls();
    sentMail.length = 0;
    expect((await reinstate(s.po_id)).status).toBe(200);
    await drainPostCommitWork();
    await new Promise((r) => setTimeout(r, 50));

    expect(trackedCalls("sendPOAcceptanceRequestToVendor")).toHaveLength(1);
    const vendorMail = sentMail.filter((m) => String(m.to).includes("alpha@vendor.test"));
    expect(vendorMail).toHaveLength(1);
    expect(vendorMail[0].subject).toMatch(/Action Required: PO #/);
    for (const m of vendorMail) {
      expect(m.html).not.toContain("INTERNAL-NOTE-7731");
      expect(m.subject).not.toContain("INTERNAL-NOTE-7731");
    }

    const vendorRows = await db.any(
      `SELECT type, title, message, additional_data FROM tbl_notifications
        WHERE recipient_user_id = $1 AND (additional_data->>'po_id') = $2`, [ALPHA, String(s.po_id)]);
    expect(vendorRows.map((r) => r.type)).toContain("po_acceptance_request");
    expect(JSON.stringify(vendorRows)).not.toContain("INTERNAL-NOTE-7731");
    expect(vendorRows.map((r) => r.type)).not.toContain("po_sent_back_to_vendor");
  });

  it("other evaluators get the sent-back notice with the note; the actor does not", async () => {
    const s = await rejectedPo();
    await settle();
    sentMail.length = 0;
    expect((await reinstate(s.po_id)).status).toBe(200);
    await drainPostCommitWork();
    await new Promise((r) => setTimeout(r, 50));

    const rows = await db.any(
      `SELECT recipient_user_id, title, message FROM tbl_notifications
        WHERE type = 'po_sent_back_to_vendor' AND (additional_data->>'po_id') = $1`, [String(s.po_id)]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.recipient_user_id)).not.toContain(EVALUATOR);
    expect(rows[0].title).toBe("PO sent back to the vendor");
    expect(rows[0].message).toMatch(/^.+ sent PO #\S+ back to .+ for acceptance: “/);
    expect(rows[0].message).toContain(NOTE);
    // The internal email carries the note; the actor is not mailed.
    const internal = sentMail.filter((m) => !String(m.to).includes("vendor.test"));
    expect(internal.length).toBeGreaterThan(0);
    expect(internal.every((m) => m.html.includes("INTERNAL-NOTE-7731"))).toBe(true);
    expect(internal.map((m) => m.to)).not.toContain("admin.a@test.local");
  });

  it("a user without quote-compare.create gets 403 NOT_PERMITTED and nothing changes", async () => {
    const s = await rejectedPo();
    const { status, body } = await reinstate(s.po_id, NOTE, NO_QC);
    expect(status).toBe(403);
    expect(body).toMatchObject({ status: 0, code: "NOT_PERMITTED" });
    expect((await readPo(s.po_id)).status).toBe("rejected_by_vendor");
    expect(await live(s.rfq_id)).toEqual([]);
    expect((await lifecycle(s.po_id)).some((r) => r.stage === "PO_SENT_BACK_TO_VENDOR")).toBe(false);
  });

  it("a buyer of another company gets 404 on both the state and the action", async () => {
    const s = await rejectedPo();
    expect((await getState(s.po_id, OTHER_TENANT)).status).toBe(404);
    expect((await reinstate(s.po_id, NOTE, OTHER_TENANT)).status).toBe(404);
    expect((await getState(999999999)).status).toBe(404);
    expect((await readPo(s.po_id)).status).toBe("rejected_by_vendor");
  });

  it("a vendor token cannot reach the buyer route", async () => {
    const s = await rejectedPo();
    const client = await httpClient(ALPHA);
    expect((await client.get(`/api/v1/po/${s.po_id}/reinstate`)).status).toBe(403);
    expect((await client.post(`/api/v1/po/${s.po_id}/reinstate`).send({ note: NOTE })).status).toBe(403);
    expect((await readPo(s.po_id)).status).toBe("rejected_by_vendor");
  });

  it("the routes work end to end for a buyer", async () => {
    const s = await rejectedPo();
    // Fixture buyers carry user_type NULL, which acl() refuses; make this one a buyer (2).
    const prevType = (await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [EVALUATOR])).user_type;
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [EVALUATOR]);
    try {
      const client = await httpClient(EVALUATOR);
      const get = await client.get(`/api/v1/po/${s.po_id}/reinstate`);
      expect(get.status).toBe(200);
      expect(get.body.data.available).toBe(true);
      const post = await client.post(`/api/v1/po/${s.po_id}/reinstate`).send({ note: NOTE });
      expect(post.status).toBe(200);
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [EVALUATOR, prevType]);
    }
    expect((await readPo(s.po_id)).status).toBe("acceptance_pending");
  });

  it("blank note → 400 NOTE_REQUIRED; 1001 chars → 400 NOTE_TOO_LONG; 1000 is fine", async () => {
    const s = await rejectedPo();
    const attempts = [
      ...["", "   \n ", null, 42].map((bad) => reinstate(s.po_id, bad)),
      reinstateNoNote(s.po_id),
    ];
    for (const r of await Promise.all(attempts)) {
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({
        status: 0, code: "NOTE_REQUIRED", message: "Add a note saying why the order is being sent back.",
      });
    }
    const long = await reinstate(s.po_id, "x".repeat(1001));
    expect(long.status).toBe(400);
    expect(long.body.code).toBe("NOTE_TOO_LONG");
    expect((await readPo(s.po_id)).status).toBe("rejected_by_vendor");

    const ok = await reinstate(s.po_id, `  ${"y".repeat(1000)}  `);
    expect(ok.status).toBe(200);
    expect((await lifecycle(s.po_id)).find((r) => r.stage === "PO_SENT_BACK_TO_VENDOR").remarks).toBe("y".repeat(1000));
  });

  it("blocked when the product was re-awarded, with 409 PRODUCT_REAWARDED", async () => {
    const s = await rejectedPo();
    const betaQuote = await addQuote(s.rfq_id, BETA);
    await makeFinalization(s.rfq_id, s.product_variant_id, BETA, betaQuote);

    const state = await getState(s.po_id);
    expect(state.body.data).toMatchObject({ permitted: true, available: false, blockers: ["PRODUCT_REAWARDED"] });
    const r = await reinstate(s.po_id);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ status: 0, code: "PRODUCT_REAWARDED" });
    expect((await readPo(s.po_id)).status).toBe("rejected_by_vendor");
  });

  it("a PO that is not rejected by the vendor is 409 NOT_REJECTED_BY_VENDOR", async () => {
    const s = await awardedPo();
    const r = await reinstate(s.po_id);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("NOT_REJECTED_BY_VENDOR");
    expect((await getState(s.po_id)).body.data).toMatchObject({
      available: false, blockers: ["NOT_REJECTED_BY_VENDOR"], rejection: { reason: null, rejected_at: null },
    });
  });

  it("works long after the vendor's 24-hour undo window (buyers have no window)", async () => {
    const s = await rejectedPo();
    await db.none(`UPDATE tbl_rfq_purchase_order SET vendor_action_at = NOW() - INTERVAL '30 days' WHERE id = $1`, [s.po_id]);
    expect((await getState(s.po_id)).body.data.available).toBe(true);
    expect((await reinstate(s.po_id)).status).toBe(200);
  });

  it("vendor withdraw and buyer reinstate racing: exactly one wins", async () => {
    const s = await rejectedPo();
    const waitForLockWaiters = async (n, timeoutMs = 10_000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const { c } = await db.one(
          `SELECT COUNT(*)::int AS c FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`);
        if (c >= n) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`timed out waiting for ${n} sessions to queue on the PO row`);
    };

    let release; const held = new Promise((r) => { release = r; });
    let locked; const isLocked = new Promise((r) => { locked = r; });
    const holder = db.tx(async (t) => {
      await t.one(`SELECT id FROM tbl_rfq_purchase_order WHERE id = $1 FOR UPDATE`, [s.po_id]);
      locked();
      await held;
    });
    await isLocked;

    const withdraw = call(vendorUndo.withdrawRejection, s.po_id, ALPHA);
    const buyer = reinstate(s.po_id);
    await waitForLockWaiters(2);
    release();
    await holder;

    const [w, b] = await Promise.all([withdraw, buyer]);
    const statuses = [w.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = w.status === 409 ? w : b;
    expect(loser.body.code).toBe("NOT_REJECTED_BY_VENDOR");

    const po = await readPo(s.po_id);
    expect(po.status).toBe(w.status === 200 ? "approved" : "acceptance_pending");
    expect(await live(s.rfq_id)).toHaveLength(1);
  });

  it("legacy shape: rejection with cancelled NEGOTIATION_QUOTE and no comment on history restores cleanly", async () => {
    const s = await rejectedPo();
    expect(await nqStatus(s.nqIds[0])).toBe("CANCELLED");
    await db.none(`UPDATE tbl_quote_finalization_history SET comment = NULL WHERE rfq_id = $1`, [s.rfq_id]);

    expect((await reinstate(s.po_id)).status).toBe(200);
    expect(await nqStatus(s.nqIds[0])).toBe("APPROVED");
    expect((await live(s.rfq_id)).map((r) => r.vendor_id)).toEqual([ALPHA]);
  });

  it("after reinstate the vendor can accept, and the RFQ no longer shows PO_VENDOR_REJECTED", async () => {
    const s = await rejectedPo();
    const rejectedRows = await rfqModel.getLivePoRejectionsForRfqs([s.rfq_id]);
    expect(rejectedRows.length).toBeGreaterThan(0);
    expect(rejectedRows[0]).toMatchObject({ po_id: s.po_id, rejection_type: "vendor" });

    expect((await reinstate(s.po_id)).status).toBe(200);
    expect(await rfqModel.getLivePoRejectionsForRfqs([s.rfq_id])).toEqual([]);

    const m = mockExpress({ user: { id: ALPHA }, params: { po_id: String(s.po_id) }, body: {} });
    await poController.acceptPO(m.req, m.res);
    expect(m.calls.body).toMatchObject({ status: 1 });
    expect((await readPo(s.po_id)).status).toBe("approved");
    expect(await rfqModel.getLivePoRejectionsForRfqs([s.rfq_id])).toEqual([]);
  });

  it("is recorded in the activity registry as po_sent_back_to_vendor", () => {
    const ev = lookupEvent("POST", "/po/:po_id/reinstate") ?? lookupEvent("POST", "/po/123/reinstate");
    expect(ev).toBeTruthy();
    expect(ev.key).toBe("po_sent_back_to_vendor");
  });
});

// ===========================================================================
//  Call-off POs
// ===========================================================================

describe("buyer send-back — call-off PO", () => {
  const HC = IDS.hospitality.A;
  const HOTEL = IDS.hotels.A1;
  const DEPT = IDS.departments.proc;
  const PROC = IDS.processes.A_P1;
  const RAISER = IDS.users.a1_proc_buyer; // raised the requisition; granted mr.create below
  const VARIANT_ID = 1;
  let arcId, contractId, contractLineId, handleMrPostApproval, grantId;

  beforeAll(async () => {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-RRBUY-1','Send-back ARC',$1,$2,$3,$4,$5,'contract_active',
               NOW()-INTERVAL '30 days', NOW()-INTERVAL '20 days',
               NOW()-INTERVAL '10 days', NOW()+INTERVAL '180 days', $6) RETURNING id`,
      [TEST_CATEGORIES.beverages, HC, HOTEL, DEPT, PROC, RAISER]
    );
    arcId = arc.id;
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1,$2,1000,'litre') RETURNING id`, [arcId, VARIANT_ID]);
    contractId = (await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1,$2,'active') RETURNING id`,
      [arcId, ALPHA])).id;
    contractLineId = (await db.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1,$2,90,5,1000) RETURNING id`, [contractId, item.id])).id;
    await db.none(
      `INSERT INTO tbl_arc_contract_line_hotel (arc_contract_line_id, hotel_id, committed_qty)
       VALUES ($1, $2, 1000)`, [contractLineId, HOTEL]);
    // MR Raiser role (mr.create) at hotel A-1 for the user who raised the requisition.
    const mrRaiserRole = await db.one(`SELECT id FROM tbl_roles WHERE title = 'MR Raiser' ORDER BY id LIMIT 1`);
    grantId = (await db.one(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [RAISER, mrRaiserRole.id, HC, HOTEL, DEPT])).id;
    ({ handleMrPostApproval } = await import("../../app/controllers/mr/mrController.js"));
  });

  afterAll(async () => {
    await drainPostCommitWork();
    const poIds = (await db.any(
      `SELECT id FROM tbl_rfq_purchase_order WHERE arc_contract_id = $1`, [contractId])).map((r) => r.id);
    const mrIds = (await db.any(
      `SELECT id FROM tbl_material_requisition WHERE hospitality_company_id = $1 AND title LIKE 'RRBUY%'`, [HC])).map((r) => r.id);
    await deleteNotificationsFor({ poIds, mrIds });
    if (poIds.length) {
      await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type = 'PO' AND entity_id = ANY($1::int[])`, [poIds]);
    }
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id IN (SELECT id FROM tbl_rfq_purchase_order WHERE arc_contract_id=$1)`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_callof_po WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_material_requisition_item WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_material_requisition WHERE hospitality_company_id=$1 AND title LIKE 'RRBUY%'`, [HC]);
    await db.none(`DELETE FROM tbl_arc_contract_line_hotel WHERE arc_contract_line_id=$1`, [contractLineId]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [grantId]);
  });

  async function releaseOne(tag, qty, instId) {
    await db.none(`UPDATE tbl_arc_contract_line SET consumed_qty=0 WHERE id=$1`, [contractLineId]);
    await db.none(`UPDATE tbl_arc_contract_line_hotel SET consumed_qty=0 WHERE arc_contract_line_id=$1`, [contractLineId]);
    const mr = await db.one(
      `INSERT INTO tbl_material_requisition
         (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, submitted_at)
       VALUES ($1,$2,$3,$4,$5,'normal',$6,'pending_approval',NOW()) RETURNING *`,
      [`MR-RRBUY-${tag}`, `RRBUY ${tag}`, HC, HOTEL, DEPT, RAISER]);
    await db.none(
      `INSERT INTO tbl_material_requisition_item
         (mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id, matched_unit_rate)
       VALUES ($1,$2,$3,'litre',$4,$5,90)`, [mr.id, VARIANT_ID, qty, contractId, contractLineId]);
    await handleMrPostApproval(instId, RAISER, {
      instance: { id: instId, entity_type: "MR", entity_id: mr.id, status: "APPROVED" },
    });
    const poId = (await db.one(`SELECT po_id FROM tbl_arc_callof_po WHERE mr_id=$1`, [mr.id])).po_id;
    return { mrId: mr.id, poId };
  }
  const consumed = async () => Number((await db.one(
    `SELECT consumed_qty FROM tbl_arc_contract_line WHERE id=$1`, [contractLineId])).consumed_qty);
  const mrStatus = async (mrId) => (await db.one(`SELECT status FROM tbl_material_requisition WHERE id=$1`, [mrId])).status;

  it("user with mr.create on the MR hotel can reinstate; quantity re-reserved; MR po_released", async () => {
    const { mrId, poId } = await releaseOne("ok", 150, 72001);
    await vendorRejects(poId, ALPHA, "Cannot supply");
    expect(await consumed()).toBe(0);
    expect(await mrStatus(mrId)).toBe("approved");

    const state = await getState(poId, RAISER);
    expect(state.body.data).toMatchObject({ permitted: true, available: true, blockers: [] });

    // Raised by the actor himself: no raiser notice. The vendor is asked again.
    await settle();
    sentMail.length = 0;
    const r = await reinstate(poId, NOTE, RAISER);
    expect(r.status).toBe(200);
    await drainPostCommitWork();
    await new Promise((res) => setTimeout(res, 50));

    expect(await consumed()).toBe(150);
    expect(await mrStatus(mrId)).toBe("po_released");
    expect(await readPo(poId)).toMatchObject({ status: "acceptance_pending", vendor_reminder_count: 0, vendor_rejection_reason: null });
    const vendorMail = sentMail.filter((m) => String(m.to).includes("alpha@vendor.test"));
    expect(vendorMail).toHaveLength(1);
    expect(vendorMail[0].html).not.toContain("INTERNAL-NOTE-7731");
    const none = await db.any(
      `SELECT 1 FROM tbl_notifications WHERE type = 'po_sent_back_to_vendor' AND (additional_data->>'po_id') = $1`,
      [String(poId)]);
    expect(none).toHaveLength(0);
  });

  it("a user without mr.create on the hotel gets 403 NOT_PERMITTED; the requisition raiser is told when someone else sends it back", async () => {
    const { mrId, poId } = await releaseOne("denied", 150, 72002);
    await vendorRejects(poId, ALPHA, "Cannot supply");

    // companyA_admin can see the PO but holds no mr.create.
    const denied = await reinstate(poId, NOTE, EVALUATOR);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("NOT_PERMITTED");
    expect((await getState(poId, EVALUATOR)).body.data).toMatchObject({ permitted: false, available: false });
    expect(await mrStatus(mrId)).toBe("approved");
    expect(await consumed()).toBe(0);

    // Temporarily let the admin act too; the raiser is a different person and is told.
    const mrRaiserRole = await db.one(`SELECT id FROM tbl_roles WHERE title = 'MR Raiser' ORDER BY id LIMIT 1`);
    const extra = await db.one(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`, [EVALUATOR, mrRaiserRole.id, HC, HOTEL, DEPT]);
    try {
      expect((await reinstate(poId, NOTE, EVALUATOR)).status).toBe(200);
    } finally {
      await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [extra.id]);
    }
    await drainPostCommitWork();
    const rows = await db.any(
      `SELECT recipient_user_id, message FROM tbl_notifications
        WHERE type = 'po_sent_back_to_vendor' AND (additional_data->>'po_id') = $1`, [String(poId)]);
    expect(rows.map((r) => r.recipient_user_id)).toEqual([RAISER]);
    expect(rows[0].message).toContain(NOTE);
  });
});
