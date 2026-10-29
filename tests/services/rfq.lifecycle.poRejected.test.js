// RFQ lifecycle stage PO_REJECTED — "PO rejected by approver" (client ticket T3).
// ----------------------------------------------------------------------------
// When an internal approver rejects a PO for re-award, its product goes back to
// commercial evaluation. Until the product is awarded again (re-finalized OR on
// a live replacement PO, either one clears it) the RFQ says so: PO_REJECTED,
// mirroring the existing PO_VENDOR_REJECTED. The CASE order is deliberate and
// pinned here (ruling R23 puts PO_REJECTED below the re-award's own work, so
// the stage names whoever owns the next step):
//
//   PO_APPROVAL (a sibling PO still with its approver)
//     > PO_VENDOR_REJECTED
//       > QUOTATION_APPROVAL (the re-award's award approval)
//         > NEGOTIATION_ONGOING (a live negotiation round)
//           > PO_REJECTED
//
// The list card's po_rejection marker does not depend on the stage: it stays
// while the re-award is in negotiation or approval.
//
// The re-award chip (RFQ detail `vendor_rejections`, list card `po_rejection`)
// carries the rejected PO's id and the approver's reason.
//
// Real HTTP, real Postgres. Mail is captured at the SMTP transport.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";

const fakeTransport = { sendMail: (opts, cb) => cb(null, { messageId: "<captured>" }) };
jest.unstable_mockModule("nodemailer", () => {
  const api = { createTransport: () => fakeTransport };
  return { default: api, ...api };
});

const { db, closeDb } = await import("../setup/db.js");
const { makePoRejectWorld, W } = await import("../helpers/poRejectWorld.js");
const { drainPoRejectedNotifications } = await import("../../app/services/po/poRejectionNotifier.js");

const world = makePoRejectWorld(db);

beforeAll(() => world.setup());
afterEach(async () => {
  await drainPoRejectedNotifications();
  await world.cleanup();
});
afterAll(async () => {
  await world.teardown();
  await closeDb();
});

const lifecycle = async (rfqId) => {
  // The CEO-level initiator reads every stage; the RFQ creator cannot see the PO panel.
  const res = await (await world.client(W.INITIATOR)).get(`/api/v1/rfq/${rfqId}/lifecycle`);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe(1);
  const poStage = res.body.data.stages.find((s) => s.key === "purchase-order");
  return { stage: res.body.data.current_status, subStatus: poStage?.phase?.sub_status };
};
const listRow = async (rfqId) => {
  const res = await (await world.client(W.CREATOR)).post("/api/v1/rfq/list-view").send({ page: 1, limit: 100 });
  expect(res.status).toBe(200);
  return res.body.data.rows.find((r) => Number(r.id) === Number(rfqId));
};
const detailRejections = async (rfqId) => {
  const res = await (await world.client(W.CREATOR)).get(`/api/v1/rfq/getRfqById/${rfqId}`);
  expect(res.status).toBe(200);
  return res.body.data.vendor_rejections;
};

/** Two products, P1 -> vendor A and P2 -> vendor B, both POs pending approval. */
async function twoPendingPos() {
  const staged = await world.stageRfq({ products: 2, vendors: [W.VENDOR_A, W.VENDOR_B] });
  const [p1, p2] = staged.products;
  const poA = (await world.award(staged, p1, [W.VENDOR_A])).pos[0].id;
  const poB = (await world.award(staged, p2, [W.VENDOR_B])).pos[0].id;
  await world.initiate(poA);
  await world.initiate(poB);
  return { staged, poA, poB, p1, p2 };
}

describe("RFQ lifecycle — PO rejected by approver", () => {
  it("puts the RFQ in PO_REJECTED and gives the chip the PO and the reason", async () => {
    const a = await world.pendingPo();
    const res = await world.rejectOnPoPage(a.poId, { remarks: "photos missing", reason_category: "EVIDENCE_MISSING" });
    expect(res.status).toBe(200);
    const poNumber = (await db.one(`SELECT po_number FROM tbl_rfq_purchase_order WHERE id = $1`, [a.poId])).po_number;

    expect(await lifecycle(a.rfq.id)).toEqual({ stage: "PO_REJECTED", subStatus: "approver_rejected" });

    const row = await listRow(a.rfq.id);
    expect(row.lifecycle_stage).toBe("PO_REJECTED");
    expect(row.po_rejection).toEqual(expect.objectContaining({
      po_id: a.poId, po_number: poNumber, rejection_type: "approver",
      reason_category: "EVIDENCE_MISSING", rejection_reason: "photos missing",
    }));

    expect(await detailRejections(a.rfq.id)).toEqual([expect.objectContaining({
      po_id: a.poId, po_number: poNumber, rejection_type: "approver",
      reason_category: "EVIDENCE_MISSING", rejection_reason: "photos missing",
    })]);
  });

  it("leaves PO_REJECTED once the product is awarded again", async () => {
    const staged = await world.stageRfq({ products: 1, vendors: [W.VENDOR_A, W.VENDOR_B] });
    const poA = (await world.award(staged, staged.products[0], [W.VENDOR_A])).pos[0].id;
    await world.initiate(poA);
    expect((await world.rejectOnPoPage(poA, { remarks: "x", reason_category: "RENEGOTIATE" })).status).toBe(200);
    expect((await lifecycle(staged.rfq.id)).stage).toBe("PO_REJECTED");

    // Re-awarded and approved: the next step is raising the PO (R23 ranks
    // AWAITING_PO above PO_REJECTED, so this pins the end state, not the
    // clearing clauses; those are pinned in isolation below).
    await world.award(staged, staged.products[0], [W.VENDOR_B]);
    expect((await lifecycle(staged.rfq.id)).stage).toBe("AWAITING_PO");
    expect((await listRow(staged.rfq.id)).po_rejection).toBeNull();
  });

  it("does not call a cancelled PO a rejection waiting for re-award, but says why it was cancelled", async () => {
    const a = await world.pendingPo();
    expect((await world.rejectOnPoPage(a.poId, { remarks: "not needed", reason_category: "NOT_REQUIRED" })).status).toBe(200);
    const poNumber = (await db.one(`SELECT po_number FROM tbl_rfq_purchase_order WHERE id = $1`, [a.poId])).po_number;
    // Not waiting for a re-award: the RFQ is back in commercial evaluation.
    expect((await lifecycle(a.rfq.id)).stage).toBe("COMMERCIAL_EVALUATION");
    // The product shows as unawarded, so the reason travels with it: an
    // approver said it is not needed (route CANCEL), not "re-award it".
    const cancelled = expect.objectContaining({
      po_id: a.poId, po_number: poNumber, rejection_type: "approver", route: "CANCEL",
      reason_category: "NOT_REQUIRED", rejection_reason: "not needed",
    });
    expect(await detailRejections(a.rfq.id)).toEqual([cancelled]);
    const row = await listRow(a.rfq.id);
    expect(row.lifecycle_stage).toBe("COMMERCIAL_EVALUATION");
    expect(row.po_rejection).toEqual(cancelled);

    // The vendor reads none of it.
    const vendor = await (await world.client(W.VENDOR_A)).get(`/api/v1/rfq/getRfqById/${a.rfq.id}`);
    expect(vendor.status).toBe(200);
    expect(vendor.body.data.vendor_rejections).toEqual([]);
    const seen = JSON.stringify(vendor.body);
    expect(seen).not.toContain("not needed");
    expect(seen).not.toContain("NOT_REQUIRED");
    expect(seen).not.toContain('"route"');
  });

  it("says nothing about a PO cancelled any other way", async () => {
    const a = await world.pendingPo();
    // Cancelled by a path that records no CANCEL decision: a draft replaced
    // by a re-award, a merge source, a PO whose RFQ was closed. Written
    // directly, as closing the RFQ leaves a held PO: cancelled, its hold
    // CLOSED (RFQ_CLOSED). The award is archived as well, so the product is
    // unawarded and nothing but the route can keep this PO off the list.
    await db.none(`UPDATE tbl_rfq_purchase_order SET status = 'cancelled' WHERE id = $1`, [a.poId]);
    await db.none(
      `INSERT INTO tbl_po_send_backs
         (purchase_order_id, rfq_id, approval_instance_id, approval_instance_step_id, step_order, route,
          reason_category, comment, requested_by, target_role, target_user_id, status, resolution, closed_at)
       VALUES ($1, $2, $3, $4, 1, 'INFO_REQUEST', 'INFO_MISSING', 'which floor?', $5, 'RFQ_CREATOR', $6,
               'CLOSED', 'RFQ_CLOSED', NOW())`,
      [a.poId, a.rfq.id, a.instanceId, await world.currentStepId(a.instanceId), W.PO_APPROVER, W.CREATOR]
    );
    await db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = $1`, [a.rfq.id]);

    expect(await detailRejections(a.rfq.id)).toEqual([]);
    expect((await listRow(a.rfq.id)).po_rejection).toBeNull();
  });

  it("I2: in PO_REJECTED the commercial evaluators hold the re-award, not the PO initiators", async () => {
    const a = await world.pendingPo();
    expect((await world.rejectOnPoPage(a.poId, { remarks: "too slow", reason_category: "RENEGOTIATE" })).status).toBe(200);
    expect((await lifecycle(a.rfq.id)).stage).toBe("PO_REJECTED");

    // COMM_EVAL holds quote-compare read+create (a commercial evaluator).
    // PO_APPROVER holds awarding read+create and no quote-compare: a PO
    // initiator only, with nothing to do until the product is awarded again.
    const expectEvaluators = (holders) => {
      expect(holders).toMatchObject({ type: "permission", kind: "evaluation", label: "Commercial Evaluators" });
      const ids = holders.users.map((u) => Number(u.id));
      expect(ids).toContain(W.COMM_EVAL);
      expect(ids).not.toContain(W.PO_APPROVER);
    };
    const detail = await (await world.client(W.CREATOR)).get(`/api/v1/rfq/getRfqById/${a.rfq.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.lifecycle_stage).toBe("PO_REJECTED");
    expectEvaluators(detail.body.data.action_holders);
    const row = await listRow(a.rfq.id);
    expect(row.lifecycle_stage).toBe("PO_REJECTED");
    expectEvaluators(row.action_holders);

    // Quote Comparison, where the re-award is done (the evaluator holds
    // quote-compare.read, not rfq.read): its banner tells the evaluator the
    // next step is theirs, and does not name the PO-initiator-only user.
    const qc = await (await world.client(W.COMM_EVAL)).get(`/api/v1/rfq/quote-comparison-view/${a.rfq.id}`);
    expect(qc.status).toBe(200);
    const banner = qc.body.stage_actors;
    expect(banner.role_label).toBe("Commercial Evaluators");
    expect(banner.actors).toEqual(expect.arrayContaining([expect.objectContaining({ user_id: W.COMM_EVAL, is_me: true })]));
    expect(banner.actors.map((u) => u.user_id)).not.toContain(W.PO_APPROVER);
  });

  it("M3: a vendor never sees the internal PO_REJECTED stage", async () => {
    const staged = await world.stageRfq({ products: 1, vendors: [W.VENDOR_A, W.VENDOR_B] });
    const poA = (await world.award(staged, staged.products[0], [W.VENDOR_A])).pos[0].id;
    await world.initiate(poA);
    expect((await world.rejectOnPoPage(poA, { remarks: "x", reason_category: "RENEGOTIATE" })).status).toBe(200);
    expect((await lifecycle(staged.rfq.id)).stage).toBe("PO_REJECTED");

    // For the vendors it is back in evaluation, which is true for them; who
    // evaluates is not theirs to read.
    for (const vendorId of [W.VENDOR_A, W.VENDOR_B]) {
      const res = await (await world.client(vendorId)).get(`/api/v1/rfq/getRfqById/${staged.rfq.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.lifecycle_stage).toBe("COMMERCIAL_EVALUATION");
      expect(res.body.data.action_holders ?? null).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain("PO_REJECTED");
    }
  });

  it("orders the CASE: pending sibling, then vendor rejection, then approver rejection", async () => {
    const { staged, poA, poB } = await twoPendingPos();

    // A rejected by the approver while B waits for its approver: PO_APPROVAL.
    expect((await world.rejectOnPoPage(poA, { remarks: "x", reason_category: "PRICE_TAX_QUERY" })).status).toBe(200);
    expect((await lifecycle(staged.rfq.id)).stage).toBe("PO_APPROVAL");

    // B approved, then refused by its vendor: both rejections are live, and
    // the vendor's refusal is the one the RFQ reports.
    expect((await world.approveOnPoPage(poB)).status).toBe(200);
    const vendorB = await world.client(W.VENDOR_B);
    const refused = await vendorB.post(`/api/v1/po/reject/${poB}`).send({ reason: "cannot deliver in time" });
    expect(refused.status).toBe(200);
    expect((await lifecycle(staged.rfq.id)).stage).toBe("PO_VENDOR_REJECTED");

    // Both appear on the chip, each with its own type; only the approver's has a reason code.
    const rows = await detailRejections(staged.rfq.id);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ po_id: poA, rejection_type: "approver", reason_category: "PRICE_TAX_QUERY" }),
      expect.objectContaining({ po_id: poB, rejection_type: "vendor", reason_category: null }),
    ]));
  });

  it("R23: a re-award in award approval reads QUOTATION_APPROVAL, and the card still shows the rejection", async () => {
    const staged = await world.stageRfq({ products: 1, vendors: [W.VENDOR_A, W.VENDOR_B] });
    const product = staged.products[0];
    const poA = (await world.award(staged, product, [W.VENDOR_A])).pos[0].id;
    await world.initiate(poA);
    expect((await world.rejectOnPoPage(poA, { remarks: "too slow", reason_category: "RENEGOTIATE" })).status).toBe(200);
    expect((await lifecycle(staged.rfq.id)).stage).toBe("PO_REJECTED");

    // The commercial evaluator raises the re-award to vendor B; it waits for its approver.
    await world.raiseAward(staged, product, [W.VENDOR_B]);
    expect((await lifecycle(staged.rfq.id)).stage).toBe("QUOTATION_APPROVAL");
    const row = await listRow(staged.rfq.id);
    expect(row.lifecycle_stage).toBe("QUOTATION_APPROVAL");
    expect(row.po_rejection).toEqual(expect.objectContaining({ po_id: poA, reason_category: "RENEGOTIATE" }));
  });

  it("R23: a re-award in an active negotiation round reads NEGOTIATION_ONGOING, and the card still shows the rejection", async () => {
    const staged = await world.stageRfq({ products: 1, vendors: [W.VENDOR_A, W.VENDOR_B] });
    const product = staged.products[0];
    const poA = (await world.award(staged, product, [W.VENDOR_A])).pos[0].id;
    await world.initiate(poA);
    expect((await world.rejectOnPoPage(poA, { remarks: "renegotiate", reason_category: "RENEGOTIATE" })).status).toBe(200);
    expect((await lifecycle(staged.rfq.id)).stage).toBe("PO_REJECTED");

    // A live round on the rejected product, open to vendor B.
    await db.none(
      `INSERT INTO tbl_negotiation_rounds
         (rfq_id, round_number, end_date, status, created_by, rfq_product_id, vendor_ids, source_type, source_id)
       VALUES ($1, 1, NOW() + INTERVAL '2 days', 'ACTIVE', $2, $3, ARRAY[$4]::int[], 'RFQ', $1)`,
      [staged.rfq.id, W.COMM_EVAL, product.id, W.VENDOR_B]
    );
    expect((await lifecycle(staged.rfq.id)).stage).toBe("NEGOTIATION_ONGOING");
    const row = await listRow(staged.rfq.id);
    expect(row.lifecycle_stage).toBe("NEGOTIATION_ONGOING");
    expect(row.po_rejection).toEqual(expect.objectContaining({ po_id: poA, reason_category: "RENEGOTIATE" }));
  });

  // The two clearing conditions of po_approver_rejected, one at a time. Each
  // needs every stage that ranks above PO_REJECTED out of play, or the test
  // reads that stage whatever the clause does: the re-award's approved award
  // (AWAITING_PO) is cancelled. What is left below PO_REJECTED for this RFQ
  // (no tech eval, bidding closed, quotes in) is COMMERCIAL_EVALUATION. The
  // control shows the same setup reads PO_REJECTED when neither condition
  // holds, so each clearing test fails if its NOT EXISTS clause is removed.
  async function reawardedWithoutAwaitingPo() {
    const staged = await world.stageRfq({ products: 1, vendors: [W.VENDOR_A, W.VENDOR_B] });
    const product = staged.products[0];
    const poA = (await world.award(staged, product, [W.VENDOR_A])).pos[0].id;
    await world.initiate(poA);
    expect((await world.rejectOnPoPage(poA, { remarks: "x", reason_category: "RENEGOTIATE" })).status).toBe(200);
    const { pos, approvalInstanceId } = await world.award(staged, product, [W.VENDOR_B]);
    expect(pos).toHaveLength(1);
    await db.none(`UPDATE tbl_approval_instances SET status = 'CANCELLED' WHERE id = $1`, [approvalInstanceId]);
    return { staged, replacementPoId: pos[0].id };
  }
  const dropReplacementPo = (poId) =>
    db.none(`UPDATE tbl_rfq_purchase_order SET status = 'cancelled' WHERE id = $1`, [poId]);
  const dropFinalization = (rfqId) => db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = $1`, [rfqId]);

  it("control: with neither a re-finalization nor a live replacement PO, the same setup reads PO_REJECTED", async () => {
    const { staged, replacementPoId } = await reawardedWithoutAwaitingPo();
    await dropReplacementPo(replacementPoId);
    await dropFinalization(staged.rfq.id);

    expect((await lifecycle(staged.rfq.id)).stage).toBe("PO_REJECTED");
  });

  it("clears PO_REJECTED on re-finalization alone (no replacement PO)", async () => {
    const { staged, replacementPoId } = await reawardedWithoutAwaitingPo();
    await dropReplacementPo(replacementPoId);
    const finalized = await db.any(`SELECT 1 FROM tbl_quote_finalization WHERE rfq_id = $1 AND vendor_id = $2`,
      [staged.rfq.id, W.VENDOR_B]);
    expect(finalized).toHaveLength(1);

    expect((await lifecycle(staged.rfq.id)).stage).toBe("COMMERCIAL_EVALUATION");
  });

  it("clears PO_REJECTED on a live replacement PO alone (no finalization)", async () => {
    const { staged, replacementPoId } = await reawardedWithoutAwaitingPo();
    await dropFinalization(staged.rfq.id);
    expect((await db.one(`SELECT status::text AS s FROM tbl_rfq_purchase_order WHERE id = $1`, [replacementPoId])).s)
      .toBe("draft");

    expect((await lifecycle(staged.rfq.id)).stage).toBe("COMMERCIAL_EVALUATION");
  });

  it("gives a rejection recorded before reasons existed a null reason_category", async () => {
    const a = await world.pendingPo();
    expect((await world.rejectOnPoPage(a.poId, { remarks: "legacy", reason_category: "INFO_MISSING" })).status).toBe(200);
    // What every rejection before this release looks like: no send-back row.
    await db.none(`DELETE FROM tbl_po_send_backs WHERE purchase_order_id = $1`, [a.poId]);

    expect((await lifecycle(a.rfq.id)).stage).toBe("PO_REJECTED");
    expect(await detailRejections(a.rfq.id)).toEqual([expect.objectContaining({
      po_id: a.poId, rejection_type: "approver", reason_category: null, rejection_reason: "legacy",
    })]);
  });
});
