// GET /api/v1/rfq/:rfqId/lifecycle — the purchase-order stage's PO tiles.
//
// The tiles used to say only who the vendor is and how much the order is for.
// A buyer looking at them could not tell where the order sat, who was holding
// it, or whether THEY were the one holding it — they had to open the PO detail
// page to find out. buildPODetail() now adds initiated_by / stage_label /
// current_actors / awaiting_me / approval.
//
// Everything here goes over real HTTP through the full middleware chain
// (auth -> acl -> tenant guard -> controller -> shaper) and asserts on the
// response body only, because that body is the contract the RFQ stage panel
// renders from.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";

// Two callers, identical read access, different standing on the approval:
//   APPROVER is a PENDING approver on the PO's current step.
//   OUTSIDER is not named on the instance at all.
// Reading the SAME PO through both is the only way to prove awaiting_me is
// per-viewer and not a property of the PO row.
const APPROVER = IDS.users.a1_proc_poApp;   // role 13 -> awarding.read
const OUTSIDER = IDS.users.a1_proc_buyer;   // role 2  -> rfq.read
const APPROVED_ALREADY = IDS.users.a1_proc_commApp;
const STILL_PENDING = IDS.users.a1_proc_finance;
const REMOVED_APPROVER = IDS.users.a1_proc_techApp;

// The purchase-order stage opens on `awarding` (there is no po.read permission
// in the catalogue at all — see rfqLifecycleShaper.js), and the tenant guard
// on the route needs rfq.read. Neither fixture user holds both, so top the
// other one up and revoke it again in afterAll.
const ROLE_RFQ = 2;
const ROLE_AWARDING = 13;

const seeded = {
  rfqIds: [],
  poIds: [],
  instanceIds: [],
  stepIds: [],
  approverIds: [],
  poProductIds: [],
  scopeIds: [],
};

let rfqId;
let pendingPoId;
let draftPoId;
let vendorPoId;
let settledPoId;
let pendingInstanceId;
let settledInstanceId;

const poNumber = (suffix) => `LCPO-${Date.now()}-${suffix}`;

async function insertPO(t, { status, poNo, approvalInstanceId = null, initiatedBy }) {
  const row = await t.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity,
        unit_price, finalized_vendor_id, total_value, initiated_by,
        approval_instance_id)
     VALUES ($1, $2, $3, $4::po_status, '{}'::int[], 58, 500, $5, 33495, $6, $7)
     RETURNING id`,
    [rfqId, IDS.hospitality.A, poNo, status, IDS.users.vendor_alpha, initiatedBy, approvalInstanceId]
  );
  return Number(row.id);
}

async function insertApprover(t, stepId, userId, status, extra = {}) {
  const row = await t.one(
    `INSERT INTO tbl_approval_step_approvers
       (approval_instance_step_id, approver_user_id, status, acted_at,
        removed_at, removal_reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [stepId, userId, status, extra.actedAt ?? null, extra.removedAt ?? null, extra.removalReason ?? null]
  );
  seeded.approverIds.push(Number(row.id));
  return Number(row.id);
}

beforeAll(async () => {
  // acl([2, 8]) on the route; shared fixtures leave user_type NULL.
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [[APPROVER, OUTSIDER]]);

  seeded.scopeIds.push(
    await grantRoleScope(db, {
      userId: APPROVER, roleId: ROLE_RFQ,
      companyId: IDS.hospitality.A, hotelId: IDS.hotels.A1, departmentId: IDS.departments.proc,
    })
  );
  seeded.scopeIds.push(
    await grantRoleScope(db, {
      userId: OUTSIDER, roleId: ROLE_AWARDING,
      companyId: IDS.hospitality.A, hotelId: IDS.hotels.A1, departmentId: IDS.departments.proc,
    })
  );

  await db.tx(async (t) => {
    const rfq = await makeRFQ(t, {
      createdBy: OUTSIDER, status: 1, is_published: 1, is_tender: 0,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      department: IDS.departments.proc, process: IDS.processes.A_P1,
      title: "Lifecycle PO tile RFQ",
    });
    rfqId = rfq.rfq_id;
    seeded.rfqIds.push(rfqId);

    const product = await t.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 1, 0)
       RETURNING id`,
      [rfqId]
    );

    // ── PO 1: sitting on step 2 of a 2-step approval ───────────────────────
    pendingPoId = await insertPO(t, {
      status: "pending_approval", poNo: poNumber("pending"), initiatedBy: OUTSIDER,
    });
    seeded.poIds.push(pendingPoId);

    const inst = await t.one(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, approval_policy_id, status, current_step,
          hospitality_company_id, hotel_id, department_id, initiated_by,
          process_id, metadata)
       VALUES ('PO', $1, $2, 'PENDING', 2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING id`,
      [
        pendingPoId, IDS.policies.A1_P1_PO, IDS.hospitality.A, IDS.hotels.A1,
        IDS.departments.proc, OUTSIDER, IDS.processes.A_P1,
        JSON.stringify({ rfq_id: rfqId }),
      ]
    );
    pendingInstanceId = Number(inst.id);
    seeded.instanceIds.push(pendingInstanceId);
    await t.none(
      `UPDATE tbl_rfq_purchase_order SET approval_instance_id = $1 WHERE id = $2`,
      [pendingInstanceId, pendingPoId]
    );

    const step1 = await t.one(
      `INSERT INTO tbl_approval_instance_steps
         (approval_instance_id, step_order, decision_rule, status, completed_at)
       VALUES ($1, 1, 'ANY', 'APPROVED', NOW()) RETURNING id`,
      [pendingInstanceId]
    );
    seeded.stepIds.push(Number(step1.id));
    await insertApprover(t, Number(step1.id), APPROVED_ALREADY, "APPROVED", { actedAt: new Date() });

    // The live step. ALL-rule, four approver rows, one of which is a tombstone.
    const step2 = await t.one(
      `INSERT INTO tbl_approval_instance_steps
         (approval_instance_id, step_order, decision_rule, status)
       VALUES ($1, 2, 'ALL', 'PENDING') RETURNING id`,
      [pendingInstanceId]
    );
    seeded.stepIds.push(Number(step2.id));
    await insertApprover(t, Number(step2.id), APPROVER, "PENDING");
    await insertApprover(t, Number(step2.id), STILL_PENDING, "PENDING");
    await insertApprover(t, Number(step2.id), APPROVED_ALREADY, "APPROVED", { actedAt: new Date() });
    await insertApprover(t, Number(step2.id), REMOVED_APPROVER, "REMOVED", {
      removedAt: new Date(), removalReason: "role_removed",
    });

    const poProduct = await t.one(
      `INSERT INTO tbl_purchase_order_product
         (purchase_order_id, rfq_product_id, quantity, unit, unit_price, total_price, product_variant_id)
       VALUES ($1, $2, 58, 'NOS', 500, 29000, 1)
       RETURNING id`,
      [pendingPoId, product.id]
    );
    seeded.poProductIds.push(Number(poProduct.id));

    // ── PO 2: never initiated — no approval instance at all ────────────────
    draftPoId = await insertPO(t, {
      status: "draft", poNo: poNumber("draft"), initiatedBy: OUTSIDER,
    });
    seeded.poIds.push(draftPoId);

    // ── PO 3: approved internally, now the vendor's move ───────────────────
    vendorPoId = await insertPO(t, {
      status: "acceptance_pending", poNo: poNumber("vendor"), initiatedBy: APPROVER,
    });
    seeded.poIds.push(vendorPoId);

    const vendorInst = await t.one(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, approval_policy_id, status, current_step,
          hospitality_company_id, hotel_id, department_id, initiated_by,
          process_id, metadata, completed_at)
       VALUES ('PO', $1, $2, 'APPROVED', 1, $3, $4, $5, $6, $7, $8::jsonb, NOW())
       RETURNING id`,
      [
        vendorPoId, IDS.policies.A1_P1_PO, IDS.hospitality.A, IDS.hotels.A1,
        IDS.departments.proc, APPROVER, IDS.processes.A_P1,
        JSON.stringify({ rfq_id: rfqId }),
      ]
    );
    seeded.instanceIds.push(Number(vendorInst.id));
    await t.none(
      `UPDATE tbl_rfq_purchase_order SET approval_instance_id = $1 WHERE id = $2`,
      [Number(vendorInst.id), vendorPoId]
    );
    const vendorStep = await t.one(
      `INSERT INTO tbl_approval_instance_steps
         (approval_instance_id, step_order, decision_rule, status, completed_at)
       VALUES ($1, 1, 'ANY', 'APPROVED', NOW()) RETURNING id`,
      [Number(vendorInst.id)]
    );
    seeded.stepIds.push(Number(vendorStep.id));
    await insertApprover(t, Number(vendorStep.id), APPROVER, "APPROVED", { actedAt: new Date() });

    // ── PO 4: settled, and the pointer was left behind ─────────────────────
    // Exactly PO 8 / approval instance 132 on stage: APPROVED, current_step 0,
    // ONE step at step_order 1 (ANY, APPROVED) whose five approvers include the
    // one who cleared it and four who never had to act. 203 instances on stage
    // carry current_step = 0 and no step anywhere is stored at step_order 0, so
    // matching the pointer literally resolved nothing at all.
    settledPoId = await insertPO(t, {
      status: "approved", poNo: poNumber("settled"), initiatedBy: OUTSIDER,
    });
    seeded.poIds.push(settledPoId);

    const settledInst = await t.one(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, approval_policy_id, status, current_step,
          hospitality_company_id, hotel_id, department_id, initiated_by,
          process_id, metadata, completed_at)
       VALUES ('PO', $1, $2, 'APPROVED', 0, $3, $4, $5, $6, $7, $8::jsonb, NOW())
       RETURNING id`,
      [
        settledPoId, IDS.policies.A1_P1_PO, IDS.hospitality.A, IDS.hotels.A1,
        IDS.departments.proc, OUTSIDER, IDS.processes.A_P1,
        JSON.stringify({ rfq_id: rfqId }),
      ]
    );
    settledInstanceId = Number(settledInst.id);
    seeded.instanceIds.push(settledInstanceId);
    await t.none(
      `UPDATE tbl_rfq_purchase_order SET approval_instance_id = $1 WHERE id = $2`,
      [settledInstanceId, settledPoId]
    );

    const settledStep = await t.one(
      `INSERT INTO tbl_approval_instance_steps
         (approval_instance_id, step_order, decision_rule, status, completed_at)
       VALUES ($1, 1, 'ANY', 'APPROVED', NOW()) RETURNING id`,
      [settledInstanceId]
    );
    seeded.stepIds.push(Number(settledStep.id));
    await insertApprover(t, Number(settledStep.id), APPROVED_ALREADY, "APPROVED", { actedAt: new Date() });
    for (const u of [APPROVER, STILL_PENDING, REMOVED_APPROVER, IDS.users.companyA_admin]) {
      await insertApprover(t, Number(settledStep.id), u, "PENDING");
    }
  });
});

afterAll(async () => {
  if (seeded.poProductIds.length) {
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE id = ANY($1::int[])`, [seeded.poProductIds]);
  }
  if (seeded.poIds.length) {
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [seeded.poIds]);
  }
  if (seeded.approverIds.length) {
    await db.none(`DELETE FROM tbl_approval_step_approvers WHERE id = ANY($1::int[])`, [seeded.approverIds]);
  }
  if (seeded.stepIds.length) {
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE id = ANY($1::int[])`, [seeded.stepIds]);
  }
  if (seeded.instanceIds.length) {
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [seeded.instanceIds]);
  }
  if (seeded.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [seeded.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [seeded.rfqIds]);
  }
  await revokeRoleScopes(db, seeded.scopeIds);
  await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = ANY($1::int[])`, [[APPROVER, OUTSIDER]]);
});

/** The purchase-order stage's PO list, as the client receives it. */
async function fetchPOs(userId) {
  const client = await httpClient(userId);
  const res = await client.get(`/api/v1/rfq/${rfqId}/lifecycle`);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe(1);
  const stage = res.body.data.stages.find((s) => s.key === "purchase-order");
  expect(stage).toBeDefined();
  // If this is false the caller lost awarding.read and every assertion below
  // would be asserting on a redacted stage instead of the real payload.
  expect(stage.can_read).toBe(true);
  return stage.phase.purchase_orders;
}

const byId = (pos, id) => pos.find((p) => Number(p.id) === Number(id));

describe("GET /rfq/:rfqId/lifecycle — PO tile enrichment", () => {
  it("keeps every pre-existing PO field at its exact current value", async () => {
    const pos = await fetchPOs(APPROVER);
    const po = byId(pos, pendingPoId);

    expect(po.po_number).toMatch(/^LCPO-\d+-pending$/);
    expect(po.status).toBe("pending_approval");
    expect(po.vendor_name).toBe("Alpha Vendor Contact");
    expect(po.vendor_company).toBe("Alpha Vendor Pvt Ltd");
    expect(po.total_amount).toBe(33495);
    expect(po.product_names).toBeTruthy();
    expect(po.created_at).toBeTruthy();
  });

  it("names who raised the PO", async () => {
    const pos = await fetchPOs(APPROVER);
    expect(byId(pos, pendingPoId).initiated_by).toEqual({
      user_id: OUTSIDER,
      name: expect.any(String),
    });
    // Different initiator on a different PO — the field is per-PO, not per-RFQ.
    expect(byId(pos, vendorPoId).initiated_by.user_id).toBe(APPROVER);
  });

  it("reports the live step: label, rule, and ACTIVE-only counts", async () => {
    const pos = await fetchPOs(APPROVER);
    const po = byId(pos, pendingPoId);

    expect(po.stage_label).toBe("Awaiting L2 approval");
    expect(po.approval).toEqual({
      instance_id: pendingInstanceId,
      instance_status: "PENDING",
      is_concluded: false,
      current_step: 2,
      total_steps: 2,
      step_status: "PENDING",
      decision_rule: "ALL",
      // Step 2 holds FOUR approver rows. The REMOVED one is a tombstone, not a
      // participant: counting it would render "1 of 4 approved" on a step that
      // only three people can ever act on, and would keep a revoked approver
      // showing as outstanding forever.
      approved_count: 1,
      pending_count: 2,
      rejected_count: 0,
      // The step is open, so nobody is excused: on a live level the effective
      // counts are identical to the raw ones.
      not_required_count: 0,
      not_reached_count: 0,
      total_count: 3,
    });
    // The five active buckets account for every active approver, on every step.
    const a = po.approval;
    expect(a.approved_count + a.rejected_count + a.pending_count +
      a.not_required_count + a.not_reached_count).toBe(a.total_count);
  });

  it("lists the people who must act now, excluding the removed approver", async () => {
    const pos = await fetchPOs(APPROVER);
    const actors = byId(pos, pendingPoId).current_actors;

    expect(actors.map((a) => a.user_id).sort()).toEqual([APPROVER, STILL_PENDING].sort());
    expect(actors.every((a) => typeof a.name === "string" && a.name.length > 0)).toBe(true);
    expect(actors.map((a) => a.user_id)).not.toContain(REMOVED_APPROVER);
    // Already acted -> not blocking anything.
    expect(actors.map((a) => a.user_id)).not.toContain(APPROVED_ALREADY);
  });

  it("awaiting_me is true for a caller who is a pending approver on the current step", async () => {
    const pos = await fetchPOs(APPROVER);
    expect(byId(pos, pendingPoId).awaiting_me).toBe(true);
  });

  it("awaiting_me is false for a caller who is not on the approval at all", async () => {
    const pos = await fetchPOs(OUTSIDER);
    const po = byId(pos, pendingPoId);

    expect(po.awaiting_me).toBe(false);
    // Same PO, same everything else — only the viewer changed.
    expect(po.stage_label).toBe("Awaiting L2 approval");
    expect(po.approval.pending_count).toBe(2);
    expect(po.current_actors.map((a) => a.user_id).sort()).toEqual([APPROVER, STILL_PENDING].sort());
  });

  it("a PO with no approval instance reads as an un-initiated draft", async () => {
    const pos = await fetchPOs(APPROVER);
    const po = byId(pos, draftPoId);

    expect(po.approval).toBeNull();
    expect(po.stage_label).toBe("Draft — not yet initiated");
    expect(po.current_actors).toEqual([]);
    expect(po.awaiting_me).toBe(false);
  });

  it("an approved PO waiting on the vendor names the vendor, with no user id", async () => {
    const pos = await fetchPOs(APPROVER);
    const po = byId(pos, vendorPoId);

    expect(po.stage_label).toBe("Awaiting vendor acceptance");
    expect(po.current_actors).toEqual([{ user_id: null, name: "Alpha Vendor Pvt Ltd" }]);
    // The approval is settled, so nobody on the buyer side is being asked for
    // anything — including the approver who signed it off.
    expect(po.awaiting_me).toBe(false);
    expect(po.approval.instance_id).toBeGreaterThan(0);
  });

  it("current_actors is always an array, never null", async () => {
    const pos = await fetchPOs(APPROVER);
    expect(pos).toHaveLength(4);
    for (const po of pos) {
      expect(Array.isArray(po.current_actors)).toBe(true);
      expect(typeof po.stage_label).toBe("string");
      expect(po.stage_label.length).toBeGreaterThan(0);
      expect(typeof po.awaiting_me).toBe("boolean");
    }
  });
});

// ===========================================================================
// The pointer left behind. `current_step` is a LIVE cursor: the engine stops
// maintaining it once the instance settles, and 203 instances on stage (120
// APPROVED, 83 CANCELLED) are sitting at 0 — a step_order no step has ever
// been stored with. Six of them are PO instances, so six real PO tiles were
// rendering "LEVEL 0 OF 1" with no rule and no progress.
// ===========================================================================
describe("GET /rfq/:rfqId/lifecycle — a concluded approval has no current level", () => {
  it("an APPROVED instance whose current_step is 0 reports its final step, not level 0", async () => {
    const pos = await fetchPOs(APPROVER);
    const po = byId(pos, settledPoId);

    expect(po.approval).toEqual({
      instance_id: settledInstanceId,
      // The honest answer to "which level is this on": none, it is finished.
      instance_status: "APPROVED",
      is_concluded: true,
      // NOT the stored 0. The step these numbers describe, which exists.
      current_step: 1,
      total_steps: 1,
      step_status: "APPROVED",
      // Both were null before, because no step matched step_order 0.
      decision_rule: "ANY",
      // "1 of 5 approved", not "0 of 0". The four who never acted were not
      // needed — an ANY step only ever required one of them.
      approved_count: 1,
      pending_count: 0,
      rejected_count: 0,
      not_required_count: 4,
      not_reached_count: 0,
      total_count: 5,
    });
    const a = po.approval;
    expect(a.approved_count + a.rejected_count + a.pending_count +
      a.not_required_count + a.not_reached_count).toBe(a.total_count);
  });

  it("never emits a current_step that the instance has no step for", async () => {
    const pos = await fetchPOs(APPROVER);
    // Every step_order stored against every instance on this RFQ.
    const rows = await db.any(
      `SELECT ai.id AS instance_id, s.step_order
         FROM tbl_approval_instances ai
         JOIN tbl_approval_instance_steps s ON s.approval_instance_id = ai.id
        WHERE ai.id = ANY($1::int[])`,
      [seeded.instanceIds]
    );
    const ordersByInstance = new Map();
    for (const r of rows) {
      const list = ordersByInstance.get(Number(r.instance_id)) || [];
      list.push(Number(r.step_order));
      ordersByInstance.set(Number(r.instance_id), list);
    }
    const withApproval = pos.filter((p) => p.approval);
    expect(withApproval.length).toBeGreaterThan(0);
    for (const po of withApproval) {
      expect(ordersByInstance.get(Number(po.approval.instance_id)))
        .toContain(po.approval.current_step);
    }
  });

  it("a settled PO is never described as awaiting an approval level", async () => {
    // Same PO read by the person who is still a PENDING row on that closed
    // step: the row says PENDING forever, but nobody is waiting on them.
    const pos = await fetchPOs(APPROVER);
    const po = byId(pos, settledPoId);

    expect(po.stage_label).toBe("With vendor · Approved");
    expect(po.stage_label).not.toContain("L0");
    expect(po.awaiting_me).toBe(false);
    expect(po.current_actors).toEqual([{ user_id: null, name: "Alpha Vendor Pvt Ltd" }]);
  });

  it("the settled instance with a well-formed pointer reads the same way", async () => {
    // Control: instance pointer = 1, one APPROVED step, one approver. Nothing
    // about the resolution changes for data the engine left consistent.
    const pos = await fetchPOs(APPROVER);
    const po = byId(pos, vendorPoId);

    expect(po.approval).toMatchObject({
      instance_status: "APPROVED",
      is_concluded: true,
      current_step: 1,
      total_steps: 1,
      step_status: "APPROVED",
      decision_rule: "ANY",
      approved_count: 1,
      pending_count: 0,
      not_required_count: 0,
      total_count: 1,
    });
  });
});
