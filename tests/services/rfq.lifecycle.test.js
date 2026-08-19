import { describe, it, test, expect, beforeAll, afterAll } from "@jest/globals";
import { shapeRfqLifecycle, STAGE_ORDER } from "../../app/models/rfq/rfqLifecycleShaper.js";
import { db } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  makeRfqVisibleToDashboard, addProductToRfq, cleanupRfqs, makePO, cleanupPurchaseOrders,
} from "../helpers/dashboardSeed.js";
import rfqModel from "../../app/models/rfqModel.js";
import { makeRFQ } from "../factories/rfq.js";

// Minimal getLifecycleSummary-shaped fixture.
const summary = (overrides = {}) => ({
  rfq_id: 7,
  current_stage: "COMMERCIAL_EVALUATION",
  current_phase: "commercial",
  user_action_required: true,
  user_can_approve: false,
  user_action_label: "You are an evaluator for this RFQ",
  user_approval_instance_id: null,
  phases: [
    { key: "rfq_approval", label: "RFQ Approval", status: "completed", summary: "Approved by A" },
    { key: "technical",    label: "Technical",    status: "skipped",   summary: null },
    { key: "commercial",   label: "Commercial",   status: "current",   summary: "Round 1 active" },
    { key: "purchase_order", label: "Purchase Order", status: "upcoming", summary: null },
  ],
  ...overrides,
});

// A caller who can read every stage. The shaper redacts by permission now, so
// tests about SHAPING must grant read or they end up asserting redaction.
const ALL_READ = {
  rfq: ["read"], te: ["read"], "quote-compare": ["read"],
  negotiation: ["read"], awarding: ["read"],
};

describe("shapeRfqLifecycle", () => {
  test("maps 4 phases to the 4 timeline stages with renamed keys", () => {
    const out = shapeRfqLifecycle(summary(), { permissions: ALL_READ });
    expect(out.stages.map((s) => s.key)).toEqual(STAGE_ORDER);
    expect(out.stages.map((s) => s.label)).toEqual([
      "Overview", "Technical Evaluation", "Negotiation & Award", "Purchase Order",
    ]);
  });

  test("maps phase.status to ARC state and picks default_stage = current phase's stage", () => {
    const out = shapeRfqLifecycle(summary(), { permissions: ALL_READ });
    const byKey = Object.fromEntries(out.stages.map((s) => [s.key, s]));
    expect(byKey["overview"].state).toBe("complete");
    expect(byKey["technical"].state).toBe("skipped");
    expect(byKey["negotiation-award"].state).toBe("active");
    expect(byKey["purchase-order"].state).toBe("locked");
    expect(out.default_stage).toBe("negotiation-award");
  });

  test("attaches the action to the current stage", () => {
    const out = shapeRfqLifecycle(summary(), { permissions: ALL_READ });
    const cur = out.stages.find((s) => s.key === "negotiation-award");
    // step_id / entity_type were added alongside instance_id so the client can
    // post an approval decision without re-deriving the step.
    expect(cur.action).toEqual({
      required: true,
      can_approve: false,
      label: "You are an evaluator for this RFQ",
      instance_id: null,
      step_id: null,
      entity_type: null,
    });
  });

  test("APPROVED_COMPLETED (no current phase) → all complete, default_stage = purchase-order", () => {
    const out = shapeRfqLifecycle(summary({
      current_stage: "APPROVED_COMPLETED", current_phase: null, user_action_required: false,
      phases: [
        { key: "rfq_approval", label: "RFQ Approval", status: "completed" },
        { key: "technical", label: "Technical", status: "skipped" },
        { key: "commercial", label: "Commercial", status: "completed" },
        { key: "purchase_order", label: "Purchase Order", status: "completed" },
      ],
    }), { permissions: ALL_READ });
    expect(out.default_stage).toBe("purchase-order");
    expect(out.stages.find((s) => s.key === "purchase-order").state).toBe("complete");
  });

  // An expired approval phase is OVER: the RFQ published without it, so nothing
  // there awaits anyone. It used to map to `active`, which made it win
  // default_stage (the first active stage) and pinned the page to Overview for
  // the rest of the RFQ's life — in production, on 194 RFQs, 112 of which had
  // already issued a purchase order.
  test("expired RFQ-approval phase → overview ENDED, and never wins default_stage", () => {
    const out = shapeRfqLifecycle(summary({
      current_stage: "COMMERCIAL_EVALUATION", current_phase: "commercial",
      phases: [
        { key: "rfq_approval", label: "RFQ Approval", status: "expired", summary: "Auto-published" },
        { key: "technical", label: "Technical", status: "skipped" },
        { key: "commercial", label: "Commercial", status: "current" },
        { key: "purchase_order", label: "Purchase Order", status: "upcoming" },
      ],
    }), { permissions: ALL_READ });
    const ov = out.stages.find((s) => s.key === "overview");
    expect(ov.state).toBe("ended");
    expect(ov.reason).toBe("expired_pending");
    // The tab that opens is the one with live work.
    expect(out.default_stage).toBe("negotiation-award");
  });

  test("an expired phase carries no action — the action belongs to the live stage", () => {
    const out = shapeRfqLifecycle(summary({
      current_stage: "COMMERCIAL_EVALUATION", current_phase: "commercial",
      user_action_required: true,
      phases: [
        { key: "rfq_approval", label: "RFQ Approval", status: "expired", summary: "Auto-published" },
        { key: "technical", label: "Technical", status: "skipped" },
        { key: "commercial", label: "Commercial", status: "current" },
        { key: "purchase_order", label: "Purchase Order", status: "upcoming" },
      ],
    }), { permissions: ALL_READ });
    // The shaper hands the SAME action object to every "current" stage. While
    // expired counted as current, Overview inherited it and rendered an amber
    // "Action needed" chip for work owned by the commercial stage.
    expect(out.stages.find((s) => s.key === "overview").action).toBeNull();
    expect(out.stages.find((s) => s.key === "negotiation-award").action).not.toBeNull();
  });

  // The RFQ stage panels render straight from this payload — the PO list with
  // vendor names and ₹ totals, per-product finalization and negotiation prices
  // — unlike the ARC page, whose stages fetch from separately-gated endpoints.
  // Hiding those panels client-side alone would leave the numbers in the JSON.
  describe("stage redaction by permission", () => {
    const withDetail = (perms) => shapeRfqLifecycle(summary({
      current_stage: "AWAITING_PO", current_phase: "purchase_order",
      phases: [
        { key: "rfq_approval", label: "RFQ Approval", status: "completed", summary: "Approved by A" },
        { key: "technical", label: "Technical", status: "completed", summary: "3 passed, 1 failed" },
        { key: "commercial", label: "Commercial", status: "completed", summary: "1 product finalized",
          products: [{ product_name: "Bed linen", finalized_vendor: "Alpha Textiles", value: 420000 }] },
        { key: "purchase_order", label: "Purchase Order", status: "current", summary: "2 POs · ₹4,20,000",
          purchase_orders: [{ id: 9, po_number: "PO/2026/9", vendor_name: "Alpha Textiles", total_amount: 420000 }] },
      ],
    }), { permissions: perms });

    test("a caller with only rfq.read gets every other stage's detail stripped", () => {
      const out = withDetail({ rfq: ["read"] });
      const byKey = Object.fromEntries(out.stages.map((s) => [s.key, s]));

      expect(byKey["overview"].can_read).toBe(true);
      for (const key of ["technical", "negotiation-award", "purchase-order"]) {
        expect(byKey[key].can_read).toBe(false);
        expect(byKey[key].summary).toBeNull();
        expect(byKey[key].action).toBeNull();
        expect(byKey[key].phase.purchase_orders).toBeUndefined();
        expect(byKey[key].phase.products).toBeUndefined();
      }

      // Nothing commercially sensitive survives anywhere in the payload.
      const json = JSON.stringify(out);
      expect(json).not.toMatch(/Alpha Textiles/);
      expect(json).not.toMatch(/PO\/2026\/9/);
      expect(json).not.toMatch(/420000/);
      expect(json).not.toMatch(/4,20,000/);
    });

    test("never opens the page on a stage the caller cannot read", () => {
      // purchase-order is the live stage, but this caller cannot see it.
      const out = withDetail({ rfq: ["read"] });
      expect(out.default_stage).toBe("overview");
    });

    test("awarding.read — not the non-existent po.read — opens the PO stage", () => {
      const out = withDetail({ rfq: ["read"], awarding: ["read"] });
      const byKey = Object.fromEntries(out.stages.map((s) => [s.key, s]));
      expect(byKey["purchase-order"].can_read).toBe(true);
      expect(byKey["purchase-order"].phase.purchase_orders).toHaveLength(1);
      expect(out.default_stage).toBe("purchase-order");

      // po.read cannot open it, because no such permission exists to hold.
      const viaPo = withDetail({ rfq: ["read"], po: ["read"] });
      expect(viaPo.stages.find((s) => s.key === "purchase-order").can_read).toBe(false);
    });

    test("te.read opens only the technical stage", () => {
      const out = withDetail({ rfq: ["read"], te: ["read"] });
      const byKey = Object.fromEntries(out.stages.map((s) => [s.key, s]));
      expect(byKey["technical"].can_read).toBe(true);
      expect(byKey["negotiation-award"].can_read).toBe(false);
      expect(byKey["purchase-order"].can_read).toBe(false);
    });

    test("an approver named by policy alone can read the stage they must decide on", () => {
      // No module role at all — the approval policy is the only thing putting
      // this decision in front of them. Mirrors the ARC awarding stage.
      const out = shapeRfqLifecycle(summary({
        current_stage: "AWAITING_PO", current_phase: "purchase_order",
        phases: [
          { key: "rfq_approval", label: "RFQ Approval", status: "completed" },
          { key: "technical", label: "Technical", status: "skipped" },
          { key: "commercial", label: "Commercial", status: "completed" },
          { key: "purchase_order", label: "Purchase Order", status: "current",
            approval_instances: [{ id: 5, status: "PENDING", can_user_approve: true }] },
        ],
      }), { permissions: { rfq: ["read"] } });

      const po = out.stages.find((s) => s.key === "purchase-order");
      expect(po.can_read).toBe(true);
      expect(po.phase.approval_instances).toHaveLength(1);
    });

    test("admin on a resource opens its stage", () => {
      const out = withDetail({ rfq: ["read"], awarding: ["admin"] });
      expect(out.stages.find((s) => s.key === "purchase-order").can_read).toBe(true);
    });
  });

  test("passes through permissions and current_status", () => {
    const out = shapeRfqLifecycle(summary(), { permissions: { rfq: ["read"] } });
    expect(out.permissions).toEqual({ rfq: ["read"] });
    expect(out.current_status).toBe("COMMERCIAL_EVALUATION");
  });
});

// ── Integration: GET /api/v1/rfq/:rfqId/lifecycle ───────────────────────────
describe("GET /rfq/:rfqId/lifecycle", () => {
  const BUYER = IDS.users.a1_proc_buyer;
  let client;
  const rfqIds = [];
  let publishedId, draftId, tenderId;

  beforeAll(async () => {
    // The route is acl([2, 8]) now — the payload carries the approver matrix,
    // so vendors are kept off it entirely. Shared fixtures leave user_type NULL
    // (tests/fixtures/users.js:31), so give this buyer a production-shaped type.
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    client = await httpClient(BUYER);
    await db.tx(async (t) => {
      const pub = await makeRfqVisibleToDashboard(t, {
        createdBy: BUYER, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
        status: 1, is_published: 1, title: "Lifecycle published RFQ",
      });
      publishedId = pub.rfq_id;
      await addProductToRfq(t, publishedId);

      const draft = await makeRfqVisibleToDashboard(t, {
        createdBy: BUYER, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
        status: 0, is_published: 0, title: "Lifecycle draft RFQ",
      });
      draftId = draft.rfq_id;

      const tender = await makeRfqVisibleToDashboard(t, {
        createdBy: BUYER, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
        status: 1, is_published: 1, is_tender: 1, title: "Lifecycle tender",
      });
      tenderId = tender.rfq_id;
    });
    rfqIds.push(publishedId, draftId, tenderId);
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1)`, [rfqIds]);
    await cleanupRfqs(db, rfqIds);
    await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [BUYER]);
  });

  it("returns the 4 timeline stages + a default_stage + RFQ-scoped permissions", async () => {
    const res = await client.get(`/api/v1/rfq/${publishedId}/lifecycle`);
    expect(res.body.status).toBe(1);
    expect(res.body.data.stages.map((s) => s.key)).toEqual(STAGE_ORDER);
    expect(STAGE_ORDER).toContain(res.body.data.default_stage);
    expect(Array.isArray(res.body.data.permissions.rfq)).toBe(true);
    expect(res.body.data.rfq.id).toBe(publishedId);
  });

  it("returns a redirectable draft shape for a draft RFQ", async () => {
    const res = await client.get(`/api/v1/rfq/${draftId}/lifecycle`);
    expect(res.body.status).toBe(1);
    expect(res.body.data.rfq.status).toBe("draft");
    expect(res.body.data.stages).toEqual([]);
    expect(res.body.data.default_stage).toBeNull();
  });

  it("rejects a tender id with 403", async () => {
    const res = await client.get(`/api/v1/rfq/${tenderId}/lifecycle`);
    expect(res.status).toBe(403);
  });
});

// ── REMOVED-approver pass-through ───────────────────────────────────────────
// formatApprovalInstances (rfqModel.js) serializes the approval trail this
// endpoint feeds. It used to drop removed_at/removal_reason/added_mid_flight
// even though the upstream query (generalModel.getApprovalInstanceDetails)
// already supplies them — so a REMOVED approver arrived at the client
// unlabelled, indistinguishable from a live pending one. This does NOT filter
// REMOVED rows out (that stays the frontend's job, same as ApprovalTimeline);
// it only proves the fields survive the trip.
describe("GET /rfq/:rfqId/lifecycle — REMOVED approver pass-through", () => {
  const CREATOR = IDS.users.a1_proc_buyer;
  const inserted2 = { rfqIds: [], instanceIds: [], stepIds: [], approverIds: [] };

  afterEach(async () => {
    await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [CREATOR]);
    if (inserted2.approverIds.length) {
      await db.none(`DELETE FROM tbl_approval_step_approvers WHERE id = ANY($1::int[])`, [inserted2.approverIds]);
      inserted2.approverIds = [];
    }
    if (inserted2.stepIds.length) {
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE id = ANY($1::int[])`, [inserted2.stepIds]);
      inserted2.stepIds = [];
    }
    if (inserted2.instanceIds.length) {
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [inserted2.instanceIds]);
      inserted2.instanceIds = [];
    }
    if (inserted2.rfqIds.length) {
      await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted2.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted2.rfqIds]);
      inserted2.rfqIds = [];
    }
  });

  it("the 'overview' stage still carries a REMOVED approver's removal_reason + removed_at, alongside the live PENDING one", async () => {
    // status=3/is_published=0 -> RFQ_APPROVAL is the current stage (not a
    // draft short-circuit), so the 'overview' stage's approval_instances
    // reflects a real, in-flight RFQ approval instance.
    const { rfq_id } = await makeRFQ(db, {
      createdBy: CREATOR, status: 3, is_published: 0, is_tender: 0,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      department: IDS.departments.proc, process: IDS.processes.A_P1,
    });
    inserted2.rfqIds.push(rfq_id);
    await db.none(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 1, 0)`,
      [rfq_id]
    );

    const inst = await db.one(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, approval_policy_id, status, current_step,
          hospitality_company_id, hotel_id, department_id, initiated_by, process_id)
       VALUES ('RFQ', $1, $2, 'PENDING', 1, $3, $4, $5, $6, $7)
       RETURNING id`,
      [rfq_id, IDS.policies.A1_P1_RFQ, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, CREATOR, IDS.processes.A_P1]
    );
    inserted2.instanceIds.push(inst.id);

    const step = await db.one(
      `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
       VALUES ($1, 1, 'ANY', 'PENDING') RETURNING id`,
      [inst.id]
    );
    inserted2.stepIds.push(step.id);

    // Live, mid-flight-added PENDING approver.
    const pendingRow = await db.one(
      `INSERT INTO tbl_approval_step_approvers
         (approval_instance_step_id, approver_user_id, status, added_mid_flight)
       VALUES ($1, $2, 'PENDING', true) RETURNING id`,
      [step.id, IDS.users.a1_proc_finance]
    );
    inserted2.approverIds.push(pendingRow.id);

    // Tombstoned approver whose role was revoked mid-flight (production
    // shape: PO 138699 / RFQ 681, instance 3628).
    const removedRow = await db.one(
      `INSERT INTO tbl_approval_step_approvers
         (approval_instance_step_id, approver_user_id, status, removed_at, removal_reason)
       VALUES ($1, $2, 'REMOVED', NOW(), 'role_removed') RETURNING id`,
      [step.id, IDS.users.a1_proc_poApp]
    );
    inserted2.approverIds.push(removedRow.id);

    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [CREATOR]);
    const client = await httpClient(CREATOR);
    const res = await client.get(`/api/v1/rfq/${rfq_id}/lifecycle`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    const overview = res.body.data.stages.find((s) => s.key === "overview");
    expect(overview).toBeDefined();
    const instances = overview.phase.approval_instances;
    expect(Array.isArray(instances)).toBe(true);
    expect(instances.length).toBeGreaterThanOrEqual(1);

    const approvers = instances[0].steps[0].approvers;
    const removedApprover = approvers.find((a) => a.status === "REMOVED");
    expect(removedApprover).toBeDefined();
    expect(removedApprover.removal_reason).toBe("role_removed");
    expect(removedApprover.removed_at).toBeTruthy();

    const pendingApprover = approvers.find((a) => a.status === "PENDING");
    expect(pendingApprover).toBeDefined();
    expect(pendingApprover.added_mid_flight).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeLifecycleStages — a PO awaiting vendor acceptance is still an
// approved PO.
//
// `acceptance_pending` is the state a PO enters the moment internal approval
// COMPLETES, and it stays there until the vendor accepts (acceptPO flips it to
// 'approved'). It was missing from the "products covered by an approved PO"
// whitelist, so a fully-approved PO counted for nothing: the CASE fell past
// APPROVED_COMPLETED and PO_APPROVAL down to AWAITING_PO. That put the RFQ in
// the Ongoing tab under "Quotes finalized — purchase orders can now be raised"
// and named its PO initiators as the people who must act — on an order that
// already existed and was already approved.
//
// Every PO passes through this state, so it was never an edge case: 20 RFQs
// were mislabelled when it was found (e.g. RFQ 536374 / PO 138756, approved
// at both levels and awaiting vendor acceptance).
// ---------------------------------------------------------------------------
describe("computeLifecycleStages — PO awaiting vendor acceptance", () => {
  const BUYER = IDS.users.a1_proc_buyer;
  const VENDOR = IDS.users.vendor_alpha;
  const rfqIds = [];
  const poIds = [];

  afterAll(async () => {
    await cleanupPurchaseOrders(db, poIds);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1)`, [rfqIds]);
    await cleanupRfqs(db, rfqIds);
  });

  /** One RFQ, one product, one PO in `status` covering that product. */
  async function rfqWithPoInStatus(status) {
    const seeded = await db.tx(async (t) => {
      const { rfq_id } = await makeRfqVisibleToDashboard(t, {
        createdBy: BUYER, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
        status: 1, is_published: 1, title: `Lifecycle PO ${status}`,
      });
      const { rfq_product_id } = await addProductToRfq(t, rfq_id);
      const { po_id } = await makePO(t, {
        rfq_id, rfq_product_id, status,
        company_id: IDS.hospitality.A,
        vendor_user_id: VENDOR,
        initiated_by: BUYER,
      });
      return { rfq_id, po_id };
    });
    rfqIds.push(seeded.rfq_id);
    poIds.push(seeded.po_id);
    return seeded.rfq_id;
  }

  it("reads as APPROVED_COMPLETED, not AWAITING_PO", async () => {
    const rfq_id = await rfqWithPoInStatus("acceptance_pending");
    const stages = await rfqModel.computeLifecycleStages([rfq_id]);

    // The defect: this was AWAITING_PO, so the listing asked the PO initiators
    // to raise a purchase order that was already raised and approved.
    expect(stages[rfq_id]).not.toBe("AWAITING_PO");
    expect(stages[rfq_id]).toBe("APPROVED_COMPLETED");
  });

  it("an accepted PO still reads as APPROVED_COMPLETED (control)", async () => {
    const rfq_id = await rfqWithPoInStatus("approved");
    const stages = await rfqModel.computeLifecycleStages([rfq_id]);
    expect(stages[rfq_id]).toBe("APPROVED_COMPLETED");
  });

  it("a PO still awaiting internal approval is PO_APPROVAL, not complete", async () => {
    const rfq_id = await rfqWithPoInStatus("pending_approval");
    const stages = await rfqModel.computeLifecycleStages([rfq_id]);
    expect(stages[rfq_id]).toBe("PO_APPROVAL");
  });
});
