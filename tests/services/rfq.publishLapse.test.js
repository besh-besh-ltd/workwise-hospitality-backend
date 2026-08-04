// An RFQ that PUBLISHED while its approval was still open.
//
// Publication never waits for the approval: when the publish date arrives the
// RFQ goes out and the approval instance is simply left PENDING. Nothing ever
// closes it. In production that state is not an edge case — 194 of the 195
// PENDING RFQ approval instances belong to RFQs that are already published,
// 189 of them past their bid end date, and 112 of them with a purchase order
// already issued.
//
// The system disagreed with itself about what that state means. The pending
// approval COUNTS excluded these instances, but the RFQ details page offered
// the approver a live Approve/Reject card, the pending approvals LIST still
// returned them, and both write endpoints still accepted the decision — so
// approvers acted on them, months after the RFQ had gone out.
//
// These tests pin the settled behaviour: the phase is over, no decision is
// offered, no decision is accepted, and nothing about a normal pre-publication
// approval changes.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { db } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

const CREATOR = IDS.users.a1_proc_buyer;
const APPROVER = IDS.users.a1_proc_finance;
const OTHER_TENANT = IDS.users.companyB_admin;
// CEO at Company A — holds read on every stage resource (rfq, te,
// quote-compare, negotiation, awarding), so nothing is redacted for them.
const BROAD_READER = IDS.users.companyA_admin;
const VENDOR = IDS.users.vendor_alpha;

const inserted = { rfqIds: [], instanceIds: [], stepIds: [], approverIds: [] };

// acl() branches on tbl_users.user_type and the shared fixtures leave it NULL
// (tests/fixtures/users.js:31). The lifecycle route is acl([2, 8]) — buyer or
// super-admin — so give these users production-shaped types, and put them back
// afterwards since suites in a Jest process share one database.
beforeAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`,
    [[CREATOR, APPROVER, OTHER_TENANT, BROAD_READER]]);
  await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = $1`, [VENDOR]);
});

afterAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = ANY($1::int[])`,
    [[CREATOR, APPROVER, OTHER_TENANT, BROAD_READER, VENDOR]]);
});

/**
 * Seed an RFQ with a two-step RFQ approval instance sitting on step 1.
 *
 * Two steps on purpose: approving step 1 advances the instance instead of
 * completing it, so the pre-publication regression test exercises the guard
 * without firing the terminal post-approval dispatch (which publishes and
 * talks to the scheduler).
 */
async function seedRfqWithPendingApproval({ published }) {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: CREATOR,
    status: published ? 1 : 3,
    is_published: published ? 1 : 0,
    is_tender: 0,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);

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
    [rfq_id, IDS.policies.A1_P1_RFQ, IDS.hospitality.A, IDS.hotels.A1,
     IDS.departments.proc, CREATOR, IDS.processes.A_P1]
  );
  inserted.instanceIds.push(inst.id);

  const stepIds = [];
  for (const order of [1, 2]) {
    const step = await db.one(
      `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
       VALUES ($1, $2, 'ANY', 'PENDING') RETURNING id`,
      [inst.id, order]
    );
    inserted.stepIds.push(step.id);
    stepIds.push(step.id);

    const row = await db.one(
      `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
       VALUES ($1, $2, 'PENDING') RETURNING id`,
      [step.id, APPROVER]
    );
    inserted.approverIds.push(row.id);
  }

  return { rfqId: rfq_id, instanceId: inst.id, stepId: stepIds[0] };
}

beforeEach(() => {
  inserted.rfqIds = [];
  inserted.instanceIds = [];
  inserted.stepIds = [];
  inserted.approverIds = [];
});

afterEach(async () => {
  if (inserted.instanceIds.length) {
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [inserted.instanceIds]);
  }
  if (inserted.approverIds.length) {
    await db.none(`DELETE FROM tbl_approval_step_approvers WHERE id = ANY($1::int[])`, [inserted.approverIds]);
  }
  if (inserted.stepIds.length) {
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE id = ANY($1::int[])`, [inserted.stepIds]);
  }
  if (inserted.instanceIds.length) {
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [inserted.instanceIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
});

describe("Published RFQ with an approval still open — what the page is told", () => {
  it("settles the approval stage as ended, flags it, and points the page at live work", async () => {
    const { rfqId } = await seedRfqWithPendingApproval({ published: true });

    const client = await httpClient(APPROVER);
    const res = await client.get(`/api/v1/rfq/${rfqId}/lifecycle`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    const overview = res.body.data.stages.find((s) => s.key === "overview");
    expect(overview.state).toBe("ended");
    expect(overview.reason).toBe("expired_pending");
    expect(overview.phase.published_without_approval).toBe(true);

    // The settled stage carries no user action — that shared action object is
    // what made Overview render an amber "Action needed" chip.
    expect(overview.action).toBeNull();
  });

  it("opens on the stage with live work, for a reader who can see that stage", async () => {
    const { rfqId } = await seedRfqWithPendingApproval({ published: true });

    const client = await httpClient(BROAD_READER);
    const res = await client.get(`/api/v1/rfq/${rfqId}/lifecycle`);
    expect(res.status).toBe(200);

    // Overview winning default_stage forever was half the reported bug.
    expect(res.body.data.default_stage).not.toBe("overview");
    expect(res.body.data.stages.find((s) => s.key === "overview").state).toBe("ended");
  });

  it("falls back to Overview rather than opening a stage the reader cannot see", async () => {
    const { rfqId } = await seedRfqWithPendingApproval({ published: true });

    // This approver is a Tender Approver: rfq.read and boq.read, nothing
    // downstream. The live stage is redacted for them, so opening there would
    // land them on a no-permission panel instead of the RFQ.
    const client = await httpClient(APPROVER);
    const res = await client.get(`/api/v1/rfq/${rfqId}/lifecycle`);

    expect(res.body.data.default_stage).toBe("overview");
    const po = res.body.data.stages.find((s) => s.key === "purchase-order");
    expect(po.can_read).toBe(false);
  });

  it("tells the approver they cannot approve, even though the instance is still PENDING", async () => {
    const { rfqId, instanceId } = await seedRfqWithPendingApproval({ published: true });

    const client = await httpClient(APPROVER);
    const res = await client.get(`/api/v1/rfq/${rfqId}/lifecycle`);

    const overview = res.body.data.stages.find((s) => s.key === "overview");
    const instance = overview.phase.approval_instances.find((i) => i.id === instanceId);

    // The record is still shown in full — that is the Overview approval panel's
    // whole purpose — but the grant that drives the decision card is cleared.
    expect(instance).toBeDefined();
    expect(instance.status).toBe("PENDING");
    expect(instance.can_user_approve).toBe(false);
    expect(instance.user_approval_step_id).toBeNull();
    expect(res.body.data.action.can_approve).toBe(false);

    // The approver is still named, so "who was it waiting on?" is answerable.
    const approvers = instance.steps.flatMap((s) => s.approvers || []);
    expect(approvers.some((a) => a.user_id === APPROVER)).toBe(true);
  });
});

describe("Published RFQ with an approval still open — what the API accepts", () => {
  it("refuses the decision on POST /rfq/:id/approve-action with 400", async () => {
    const { rfqId, instanceId, stepId } = await seedRfqWithPendingApproval({ published: true });

    const client = await httpClient(APPROVER);
    const res = await client.post(`/api/v1/rfq/${rfqId}/approve-action`).send({
      approval_instance_id: instanceId,
      approval_instance_step_id: stepId,
      action: "APPROVE",
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already been published/i);

    // Nothing was written: the instance is untouched, no audit row was added.
    const after = await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [instanceId]);
    expect(after.status).toBe("PENDING");
    const actions = await db.any(`SELECT id FROM tbl_approval_actions WHERE approval_instance_id = $1`, [instanceId]);
    expect(actions).toHaveLength(0);
  });

  it("refuses a REJECT too — it would stamp REJECTED on a live RFQ without un-publishing it", async () => {
    const { rfqId, instanceId, stepId } = await seedRfqWithPendingApproval({ published: true });

    const client = await httpClient(APPROVER);
    const res = await client.post(`/api/v1/rfq/${rfqId}/approve-action`).send({
      approval_instance_id: instanceId,
      approval_instance_step_id: stepId,
      action: "REJECT",
      comment: "Should never land",
    });

    expect(res.status).toBe(400);
    const after = await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [instanceId]);
    expect(after.status).toBe("PENDING");
    const rfq = await db.one(`SELECT status, is_published FROM tbl_rfq WHERE id = $1`, [rfqId]);
    expect(rfq.is_published).toBe(1);
  });

  it("refuses it on the generic approval endpoint as well", async () => {
    const { instanceId, stepId } = await seedRfqWithPendingApproval({ published: true });

    const client = await httpClient(APPROVER);
    const res = await client.post(`/api/v1/general/hospitality/approval/action`).send({
      approval_instance_id: instanceId,
      approval_instance_step_id: stepId,
      action: "APPROVE",
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already been published/i);
  });

  it("drops it from the pending-approvals list, matching the counts", async () => {
    const { instanceId } = await seedRfqWithPendingApproval({ published: true });

    const client = await httpClient(APPROVER);
    const res = await client.get(`/api/v1/general/hospitality/approval/pending?entity_type=RFQ`);
    expect(res.status).toBe(200);

    const ids = (res.body.data || []).map((r) => r.instance_id);
    expect(ids).not.toContain(instanceId);
  });
});

describe("A normal, pre-publication RFQ approval is unaffected", () => {
  it("still accepts the decision and advances the instance", async () => {
    const { rfqId, instanceId, stepId } = await seedRfqWithPendingApproval({ published: false });

    const client = await httpClient(APPROVER);
    const res = await client.post(`/api/v1/rfq/${rfqId}/approve-action`).send({
      approval_instance_id: instanceId,
      approval_instance_step_id: stepId,
      action: "APPROVE",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    // Step 1 approved, instance moved on to step 2 (still PENDING overall).
    const inst = await db.one(`SELECT status, current_step FROM tbl_approval_instances WHERE id = $1`, [instanceId]);
    expect(inst.status).toBe("PENDING");
    expect(inst.current_step).toBe(2);
  });

  it("still offers the decision on the lifecycle payload", async () => {
    const { rfqId, instanceId } = await seedRfqWithPendingApproval({ published: false });

    const client = await httpClient(APPROVER);
    const res = await client.get(`/api/v1/rfq/${rfqId}/lifecycle`);

    const overview = res.body.data.stages.find((s) => s.key === "overview");
    expect(overview.state).toBe("active");
    expect(overview.phase.published_without_approval).toBe(false);

    const instance = overview.phase.approval_instances.find((i) => i.id === instanceId);
    expect(instance.can_user_approve).toBe(true);
  });
});

// The lifecycle payload carries the full approver matrix — names, emails,
// designations and approval comments — plus evaluator names and vendor prices.
// The route had passportSignIn and nothing else: it computed the caller's
// permissions and then never gated on them, so any authenticated user could
// walk RFQ ids and read another tenant's approval chain. Its sibling
// /rfq/lifecycle-summary/:rfqId already applied assertCanReadParentRfq.
describe("GET /rfq/:rfqId/lifecycle — tenant boundary", () => {
  it("does not serve a vendor", async () => {
    const { rfqId } = await seedRfqWithPendingApproval({ published: true });

    const client = await httpClient(VENDOR);
    const res = await client.get(`/api/v1/rfq/${rfqId}/lifecycle`);

    expect(res.status).not.toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/approval_instances/);
  });

  it("does not serve a buyer from another tenant", async () => {
    const { rfqId } = await seedRfqWithPendingApproval({ published: true });

    const client = await httpClient(OTHER_TENANT);
    const res = await client.get(`/api/v1/rfq/${rfqId}/lifecycle`);

    // Whatever the shape of the refusal, the approver matrix must not be in it.
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/approval_instances/);
    expect(body).not.toMatch(/user_email/);
  });

  it("still serves someone inside the tenant", async () => {
    const { rfqId } = await seedRfqWithPendingApproval({ published: true });

    const client = await httpClient(CREATOR);
    const res = await client.get(`/api/v1/rfq/${rfqId}/lifecycle`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.stages).toHaveLength(4);
  });
});
