import { describe, it, test, expect, beforeAll, afterAll } from "@jest/globals";
import { shapeRfqLifecycle, STAGE_ORDER } from "../../app/models/rfq/rfqLifecycleShaper.js";
import { db } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { makeRfqVisibleToDashboard, addProductToRfq, cleanupRfqs } from "../helpers/dashboardSeed.js";

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

describe("shapeRfqLifecycle", () => {
  test("maps 4 phases to the 4 timeline stages with renamed keys", () => {
    const out = shapeRfqLifecycle(summary(), { permissions: {} });
    expect(out.stages.map((s) => s.key)).toEqual(STAGE_ORDER);
    expect(out.stages.map((s) => s.label)).toEqual([
      "Overview", "Technical Evaluation", "Negotiation & Award", "Purchase Order",
    ]);
  });

  test("maps phase.status to ARC state and picks default_stage = current phase's stage", () => {
    const out = shapeRfqLifecycle(summary(), { permissions: {} });
    const byKey = Object.fromEntries(out.stages.map((s) => [s.key, s]));
    expect(byKey["overview"].state).toBe("complete");
    expect(byKey["technical"].state).toBe("skipped");
    expect(byKey["negotiation-award"].state).toBe("active");
    expect(byKey["purchase-order"].state).toBe("locked");
    expect(out.default_stage).toBe("negotiation-award");
  });

  test("attaches the action to the current stage", () => {
    const out = shapeRfqLifecycle(summary(), { permissions: {} });
    const cur = out.stages.find((s) => s.key === "negotiation-award");
    expect(cur.action).toEqual({ required: true, can_approve: false, label: "You are an evaluator for this RFQ", instance_id: null });
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
    }), { permissions: {} });
    expect(out.default_stage).toBe("purchase-order");
    expect(out.stages.find((s) => s.key === "purchase-order").state).toBe("complete");
  });

  test("expired RFQ-approval phase → overview active with reason", () => {
    const out = shapeRfqLifecycle(summary({
      current_stage: "RFQ_APPROVAL", current_phase: "rfq_approval",
      phases: [
        { key: "rfq_approval", label: "RFQ Approval", status: "expired", summary: "Auto-published" },
        { key: "technical", label: "Technical", status: "upcoming" },
        { key: "commercial", label: "Commercial", status: "upcoming" },
        { key: "purchase_order", label: "Purchase Order", status: "upcoming" },
      ],
    }), { permissions: {} });
    const ov = out.stages.find((s) => s.key === "overview");
    expect(ov.state).toBe("active");
    expect(ov.reason).toBe("expired_pending");
    expect(out.default_stage).toBe("overview");
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
