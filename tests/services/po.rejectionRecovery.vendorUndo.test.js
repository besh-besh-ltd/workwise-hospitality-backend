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
  describe, it, expect, afterAll, beforeAll, beforeEach, afterEach, jest,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import { poFixtures, newPoFixtureTracker, cleanupPoFixtures } from "../helpers/poFixtures.js";

// ---- Post-commit work ------------------------------------------------------
//
// acceptPO / rejectPO answer first and notify afterwards without awaiting
// (sendPONotificationToVendor, sendPOAcceptedNotificationToTeam,
// sendVendorRejectionNotification), and those in turn fire dispatchNotification
// without awaiting. Left alone, that work races this suite's cleanup and
// outlives closeDb() (pg-promise's end() shuts every pool in the process, the
// app's included). The real functions still run; they are only wrapped so the
// suite can wait for them. Registration order matters: notificationService is
// mocked BEFORE the real purchaseOrderEmails is loaded, so that module binds to
// the tracked dispatch, and both are mocked before the controller is loaded.
const pending = new Set();
const track = (fn) => (...args) => {
  const p = Promise.resolve().then(() => fn(...args));
  pending.add(p);
  p.then(() => pending.delete(p), () => pending.delete(p));
  return p;
};
async function drainPostCommitWork() {
  while (pending.size) await Promise.allSettled([...pending]);
}

const actualNotifications = await import("../../app/services/notificationService.js");
jest.unstable_mockModule("../../app/services/notificationService.js", () => ({
  ...actualNotifications,
  dispatch: track(actualNotifications.dispatch),
}));
const actualPoEmails = await import("../../app/controllers/po/purchaseOrderEmails.js");
jest.unstable_mockModule("../../app/controllers/po/purchaseOrderEmails.js", () => ({
  ...actualPoEmails,
  sendPONotificationToVendor: track(actualPoEmails.sendPONotificationToVendor),
  sendPOAcceptedNotificationToTeam: track(actualPoEmails.sendPOAcceptedNotificationToTeam),
  sendVendorRejectionNotification: track(actualPoEmails.sendVendorRejectionNotification),
}));

const poController = await import("../../app/controllers/po/purchaseOrderController.js");
const recovery = await import("../../app/services/po/poRejectionRecovery.js");

const ALPHA = IDS.users.vendor_alpha;
const BETA = IDS.users.vendor_beta;
const BUYER = IDS.users.a1_proc_buyer;
const HOUR = 3600_000;

afterAll(async () => {
  await drainPostCommitWork();
  await closeDb();
});

// Notifications are keyed by entity in additional_data; delete only this suite's.
async function deleteNotificationsFor({ poIds = [], mrIds = [] }) {
  if (!poIds.length && !mrIds.length) return;
  await db.none(
    `DELETE FROM tbl_notifications
      WHERE (additional_data->>'po_id') = ANY($1::text[])
         OR (additional_data->>'mr_id') = ANY($2::text[])`,
    [poIds.map(String), mrIds.map(String)]
  );
}

function mockExpress(opts = {}) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    end() { return this; },
  };
  return {
    req: { user: opts.user, params: opts.params || {}, body: opts.body || {} },
    res,
    next: jest.fn(),
    calls,
  };
}

const inserted = newPoFixtureTracker();
const { makeRfqWithProductAndVendor, makeFinalization, makePo, attachProductToPo } = poFixtures(inserted);

afterEach(async () => {
  await drainPostCommitWork();
  await deleteNotificationsFor({ poIds: inserted.poIds });
  const rfqIds = inserted.rfqIds;
  const rpIds = inserted.rfqProductIds;
  if (rpIds.length) {
    await db.none(
      `DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id IN (
         SELECT id FROM tbl_approval_instances
          WHERE entity_type = 'NEGOTIATION_QUOTE' AND entity_id = ANY($1::int[]))`,
      [rpIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instances WHERE entity_type = 'NEGOTIATION_QUOTE' AND entity_id = ANY($1::int[])`,
      [rpIds]
    );
  }
  if (rfqIds.length) {
    await db.none(`DELETE FROM tbl_quote_finalization_history WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation_cleared_vendors
        WHERE tbl_rfq_product_tech_evaluation_id IN (
          SELECT id FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1::int[]))`,
      [rfqIds]
    );
    await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  }
  await cleanupPoFixtures(inserted);
});

// ---- Setup helpers ---------------------------------------------------------

async function addProduct(rfq_id, productVariantId, vendorId = ALPHA) {
  const p = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
    [rfq_id, productVariantId]
  );
  inserted.rfqProductIds.push(p.id);
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [rfq_id, productVariantId, vendorId]
  );
  return p.id;
}

async function addQuote(rfq_id, vendorId) {
  const q = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by)
     VALUES ($1, 1, $2, $2) RETURNING id`,
    [rfq_id, vendorId]
  );
  inserted.quoteIds.push(q.id);
  return q.id;
}

/** A NEGOTIATION_QUOTE (award) approval instance with one step. */
async function insertNq(rfq_product_id, status, { stepStatus } = {}) {
  const step = stepStatus || (status === "PENDING" ? "PENDING" : "APPROVED");
  const row = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        initiated_by, hospitality_company_id, hotel_id, department_id, process_id, completed_at)
     VALUES ('NEGOTIATION_QUOTE', $1, $2, $3, 1, $4, $5, $6, $7, $8,
             CASE WHEN $3 = 'PENDING' THEN NULL ELSE LOCALTIMESTAMP END)
     RETURNING id`,
    [
      rfq_product_id, IDS.policies.A1_P1_NEGOTIATION_QUOTE, status, BUYER,
      IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, IDS.processes.A_P1,
    ]
  );
  await db.none(
    `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, status)
     VALUES ($1, 1, $2)`,
    [row.id, step]
  );
  return row.id;
}

/**
 * An awarded RFQ PO awaiting the vendor: one finalization + one APPROVED
 * NEGOTIATION_QUOTE instance per product, one PO line per product.
 * `beforePo(base)` runs just before the PO is created (to place an OLDER PO).
 */
async function awardedPo({ vendorId = ALPHA, productVariantIds = [1], beforePo = null } = {}) {
  const base = await makeRfqWithProductAndVendor({ vendorId, productVariantId: productVariantIds[0] });
  const lines = [{ rfq_product_id: base.rfq_product_id, product_variant_id: productVariantIds[0] }];
  for (const pv of productVariantIds.slice(1)) {
    lines.push({ rfq_product_id: await addProduct(base.rfq_id, pv, vendorId), product_variant_id: pv });
  }
  const finalizationIds = [];
  const nqIds = [];
  for (const l of lines) {
    finalizationIds.push(await makeFinalization(base.rfq_id, l.product_variant_id, vendorId, base.quote_id));
    nqIds.push(await insertNq(l.rfq_product_id, "APPROVED"));
  }
  if (beforePo) await beforePo(base);
  const po_id = await makePo({
    rfq_id: base.rfq_id, vendorId,
    rfq_product_ids: lines.map((l) => l.rfq_product_id),
    quote_ids: lines.map(() => base.quote_id),
  });
  for (const l of lines) await attachProductToPo(po_id, l.rfq_product_id, base.quote_id);
  return { ...base, lines, finalizationIds, nqIds, po_id };
}

async function vendorRejects(po_id, vendorId = ALPHA, reason = "Ordered the wrong item") {
  const m = mockExpress({ user: { id: vendorId }, params: { po_id: String(po_id) }, body: { reason } });
  await poController.rejectPO(m.req, m.res);
  expect(m.calls.body).toMatchObject({ status: 1 });
}

async function rejectedPo(opts = {}) {
  const s = await awardedPo(opts);
  await vendorRejects(s.po_id, opts.vendorId ?? ALPHA);
  return s;
}

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

afterEach(async () => {
  await drainPostCommitWork();
  if (inserted.poIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type = 'PO' AND entity_id = ANY($1::int[])`, [inserted.poIds]);
  }
});

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

    const { status, body } = await withdraw(s.po_id);
    expect(status).toBe(200);
    expect(body).toEqual({ status: 1, message: "Rejection withdrawn. The purchase order is accepted." });

    const po = await readPo(s.po_id);
    expect(po.status).toBe("approved");
    expect(po.vendor_rejection_reason).toBeNull();
    expect(await live(s.rfq_id)).toEqual([{ vendor_id: ALPHA }]);
    expect(await nqStatus(s.nqIds[0])).toBe("APPROVED");

    const rows = (await lifecycle(s.po_id)).filter((r) => r.stage !== "PO_REJECTED_BY_VENDOR");
    expect(rows.map((r) => [r.stage, r.action, r.performed_by])).toEqual([
      ["PO_REJECTION_WITHDRAWN", "WITHDRAW_REJECTION", ALPHA],
      ["PO_ACCEPTED_BY_VENDOR", "ACCEPT", ALPHA],
    ]);
    expect(rows[0].metadata).toMatchObject({
      rfq_id: s.rfq_id, previous_rejection_reason: "Ordered the wrong item",
    });
    expect(rows[0].metadata.previous_rejected_at).toBeTruthy();
    expect(rows[1].metadata).toMatchObject({ rfq_id: s.rfq_id });
  });

  it("withdraw notifies the commercial evaluators", async () => {
    const s = await rejectedPo();
    await withdraw(s.po_id);
    await drainPostCommitWork();
    const n = await db.oneOrNone(
      `SELECT title, message, category, action_url FROM tbl_notifications
        WHERE type = 'po_vendor_rejection_withdrawn' AND (additional_data->>'po_id') = $1 LIMIT 1`,
      [String(s.po_id)]
    );
    expect(n).not.toBeNull();
    expect(n.title).toBe("Vendor withdrew their rejection");
    expect(n.message).toMatch(/withdrew their rejection of PO #TEST-PO-\d+ and accepted it\.$/);
    expect(n.category).toBe("po");
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
