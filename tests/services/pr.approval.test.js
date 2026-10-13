// Purchase Requisitions — submit, technical-review start, approval chain,
// withdraw, approver send-back (Task 6).
//
// Product-level: real HTTP through the full middleware chain against real
// Postgres; assertions read the response and the committed rows. Pattern B
// (commit + cleanup by tracked ids). Approve / Reject go through the generic
// engine endpoint exactly as the FE calls it; that endpoint answers every
// refusal with HTTP 400 {status: 3}.
//
// Personas
//   REQ  a1_eng_buyer      PR Requester at (A, A1, eng)
//   AP1  a1_proc_commApp   PR Approver at (A, A1, eng)
//   AP2  a1_proc_finance   PR Approver at (A, A1, eng)
//   BUY  a1_proc_buyer     PR Buyer at (A, A1, every department)
//   RV   a1_proc_techEval  PR Technical Reviewer at (A, A1, eng) — only inside the review block
//
// Default policy (re-made before every test): USER AP1 (ANY), then USER AP2
// (ANY, only when the PR value ≥ ₹1,00,000). No category is mapped for review
// outside the review block, so submit goes straight to approval.

import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import {
  grantPr, revokeAllPr, draftBody, firstUsableVariant, cleanupPrs, makePrPolicy, dropPrPolicies,
  mapCategory, unmapAll, prRoleId,
} from "../helpers/prFixtures.js";
import { handlePrPostApproval } from "../../app/controllers/pr/prController.js";
import { cancelApprovalInstance } from "../../app/models/generalModel.js";
import { approvalStepEmailContext } from "../../app/helper/approvalEmailContext.js";
import { approvalActionUrl, buyerPrDetail, entityLabel } from "../../app/services/notificationLinks.js";
import { NO_APPROVER_LABEL } from "../../app/services/pr/prConstants.js";

const A = IDS.hospitality.A;
const A1 = IDS.hotels.A1;
const ENG = IDS.departments.eng;
const PROC = IDS.departments.proc;
const REQ = IDS.users.a1_eng_buyer;
const AP1 = IDS.users.a1_proc_commApp;
const AP2 = IDS.users.a1_proc_finance;
const BUY = IDS.users.a1_proc_buyer;
const RV = IDS.users.a1_proc_techEval;
const PERSONAS = [REQ, AP1, AP2, BUY, RV];

const ACTION = "/api/v1/general/hospitality/approval/action";
const PENDING = "/api/v1/general/hospitality/approval/pending";
const DASH_PENDING = "/api/v1/dashboard-v2/pending-approvals";

const prIds = [];
const roleIds = [];
let originalUserTypes = [];
let reqC, ap1C, ap2C, buyC, rvC;
let variant;
let names = new Map();

// ---------------------------------------------------------------------------
// Helpers (setup + reads only)
// ---------------------------------------------------------------------------
/** A draft whose only line is the usable catalog variant at qty 1 × `price`. */
async function createPr(price = "1000.00", overrides = {}) {
  const body = await draftBody({
    lines: [{ product_variant_id: variant.variant_id, quantity: "1", uom: "nos", estimated_unit_price: price, specification: "OEM" }],
    ...overrides,
  });
  const res = await reqC.post("/api/v1/pr").send(body);
  expect(res.status).toBe(200);
  prIds.push(res.body.data.id);
  return { id: res.body.data.id, pr_number: res.body.data.pr_number, body };
}
const submit = (id, body = {}, client = reqC) => client.post(`/api/v1/pr/${id}/submit`).send(body);
const withdraw = (id, client = reqC) => client.post(`/api/v1/pr/${id}/withdraw`).send({});
const sendBack = (id, note, client) => client.post(`/api/v1/pr/${id}/send-back`).send({ note });
const act = (client, instanceId, action, comment) =>
  client.post(ACTION).send({ approval_instance_id: instanceId, action, comment });
const detail = (id, client = reqC) => client.get(`/api/v1/pr/${id}`);

const prRow = (id) => db.one(
  `SELECT id, status, revision, estimated_total::text AS estimated_total, submitted_at, approved_at,
          approval_instance_id, returned_note, pr_number, title
     FROM tbl_purchase_requisition WHERE id = $1`, [id]);
const eventsOf = (id) => db.any(
  `SELECT event_type, actor_id, revision, payload FROM tbl_pr_event WHERE pr_id = $1 ORDER BY id`, [id]);
const eventTypes = async (id) => (await eventsOf(id)).map((e) => e.event_type);
const instancesOf = (id) => db.any(
  `SELECT id, status, current_step, initiated_by, metadata FROM tbl_approval_instances
    WHERE entity_type = 'PR' AND entity_id = $1 ORDER BY id`, [id]);
/** Instance steps in order, each with its approver user ids (non-removed) and their statuses. */
const stepsOf = (instanceId) => db.any(
  `SELECT st.step_order, st.status,
          COALESCE(array_agg(asa.approver_user_id ORDER BY asa.approver_user_id)
                   FILTER (WHERE asa.id IS NOT NULL AND asa.removed_at IS NULL), '{}') AS approvers
     FROM tbl_approval_instance_steps st
     LEFT JOIN tbl_approval_step_approvers asa ON asa.approval_instance_step_id = st.id
    WHERE st.approval_instance_id = $1
    GROUP BY st.id, st.step_order, st.status
    ORDER BY st.step_order`, [instanceId]);
/** In-app rows of the PR notification category for one PR. */
const prNotifications = (prId) => db.any(
  `SELECT recipient_user_id, type, title, action_url FROM tbl_notifications
    WHERE category = 'pr' AND additional_data->>'pr_id' = $1::text ORDER BY id`, [prId]);
const recipientsOf = async (prId, type) =>
  [...new Set((await prNotifications(prId)).filter((n) => !type || n.type === type).map((n) => n.recipient_user_id))].sort();

async function submitted(price = "1000.00") {
  const pr = await createPr(price);
  const res = await submit(pr.id);
  expect(res.status).toBe(200);
  const row = await prRow(pr.id);
  return { ...pr, instanceId: row.approval_instance_id };
}

/** The PUT body that keeps a saved PR as it is (every line sent back with its id). */
async function unchangedBody(id, overrides = {}) {
  const d = (await detail(id)).body.data;
  return {
    hotel_id: d.pr.hotel_id, department_id: d.pr.department_id, title: d.pr.title, pr_type: d.pr.pr_type,
    urgency: d.pr.urgency, required_by_date: d.pr.required_by_date, justification: d.pr.justification,
    delivery_location: d.pr.delivery_location,
    lines: d.lines.map((l) => ({
      id: l.id, product_variant_id: l.product_variant_id, free_text_name: l.free_text_name, category_id: l.category_id,
      quantity: l.quantity, uom: l.uom, estimated_unit_price: l.estimated_unit_price, specification: l.specification,
    })),
    ...overrides,
  };
}

const defaultPolicy = () => makePrPolicy({
  steps: [
    { source: "USER", id: AP1 },
    { source: "USER", id: AP2, min_amount: "100000.00" },
  ],
});

beforeAll(async () => {
  originalUserTypes = await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [PERSONAS]);
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [PERSONAS]);
  await revokeAllPr(PERSONAS);
  await unmapAll(A);
  await dropPrPolicies();
  await grantPr(REQ, "PR Requester", { departmentId: ENG });
  await grantPr(AP1, "PR Approver", { departmentId: ENG });
  await grantPr(AP2, "PR Approver", { departmentId: ENG });
  await grantPr(BUY, "PR Buyer", { departmentId: null });
  variant = await firstUsableVariant();
  names = new Map((await db.any(`SELECT id, name FROM tbl_users WHERE id = ANY($1::int[])`, [PERSONAS]))
    .map((r) => [Number(r.id), r.name]));
  reqC = await httpClient(REQ);
  ap1C = await httpClient(AP1);
  ap2C = await httpClient(AP2);
  buyC = await httpClient(BUY);
  rvC = await httpClient(RV);
});

beforeEach(async () => {
  await defaultPolicy();
});

afterEach(async () => {
  await dropPrPolicies();
});

afterAll(async () => {
  if (prIds.length) {
    await db.none(
      `DELETE FROM tbl_notifications
        WHERE (category = 'pr' AND additional_data->>'pr_id' = ANY($1::text[]))
           OR action_url = ANY($2::text[])`,
      [prIds.map(String), prIds.map((id) => buyerPrDetail(id))]);
  }
  await cleanupPrs(prIds);
  await dropPrPolicies();
  await unmapAll(A);
  await revokeAllPr(PERSONAS);
  if (roleIds.length) {
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE role_id = ANY($1::int[])`, [roleIds]);
    await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = ANY($1::int[])`, [roleIds]);
    await db.none(`DELETE FROM tbl_roles WHERE id = ANY($1::int[])`, [roleIds]);
  }
  for (const u of originalUserTypes) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [u.id, u.user_type]);
  }
});

// ---------------------------------------------------------------------------
// Submit → approval
// ---------------------------------------------------------------------------
describe("PR submit → approval chain", () => {
  it("submit.below-threshold: 99,999.99 → pending_approval with step AP1 only; the server total wins over the client's", async () => {
    const pr = await createPr("99999.99");
    const res = await submit(pr.id, { estimated_total: 1, status: "approved", revision: 9 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.pr).toMatchObject({ id: pr.id, status: "pending_approval", revision: 1 });

    const row = await prRow(pr.id);
    expect(row).toMatchObject({ status: "pending_approval", revision: 1, estimated_total: "99999.99", returned_note: null });
    expect(row.submitted_at).not.toBeNull();

    const [inst] = await instancesOf(pr.id);
    expect(inst).toMatchObject({ id: row.approval_instance_id, status: "PENDING", current_step: 1, initiated_by: REQ });
    expect(inst.metadata).toMatchObject({ pr_number: pr.pr_number, pr_id: pr.id, amount: "99999.99" });
    expect(await stepsOf(inst.id)).toEqual([{ step_order: 1, status: "PENDING", approvers: [AP1] }]);

    const events = await eventsOf(pr.id);
    expect(events.map((e) => e.event_type)).toEqual(["created", "submitted", "approval_started"]);
    expect(events[1]).toMatchObject({ actor_id: REQ, revision: 1, payload: { estimated_total: "99999.99" } });
    expect(events[2]).toMatchObject({
      actor_id: REQ, revision: 1,
      payload: { instance_id: inst.id, amount: "99999.99", steps: [{ step_order: 1, approver_ids: [AP1] }] },
    });

    // Capabilities: the requester may withdraw (no longer submit); AP1 decides.
    const asReq = (await detail(pr.id)).body.data;
    expect(asReq.capabilities).toMatchObject({ can_edit: false, can_submit: false, can_withdraw: true, can_cancel: false });
    expect(asReq.capabilities.approval).toMatchObject({ instance_id: inst.id, can_approve: false, can_send_back: false });
    const asAp1 = (await detail(pr.id, ap1C)).body.data;
    expect(asAp1.capabilities.approval).toEqual({
      instance_id: inst.id, current_step_id: expect.any(Number), can_approve: true, can_send_back: true,
    });
    expect(asAp1.approval).toMatchObject({ id: inst.id, status: "PENDING", can_user_approve: true });
    expect(asAp1.pr.now_with).toBe(`Approval step 1: ${names.get(AP1)}`);
  });

  it("approve.via-generic-endpoint: AP1 approves → approved + approved_at; requester and hotel buyers notified once", async () => {
    const pr = await submitted("5000.00");
    const res = await act(ap1C, pr.instanceId, "APPROVE", "ok");
    expect(res.status).toBe(200);
    expect(res.body.data.instance_status).toBe("APPROVED");

    const row = await prRow(pr.id);
    expect(row.status).toBe("approved");
    expect(row.approved_at).not.toBeNull();
    const events = await eventsOf(pr.id);
    expect(events[events.length - 1]).toMatchObject({ event_type: "approved", actor_id: AP1, revision: 1 });

    // The buyer the notice went to can open it; nothing is left to decide.
    const asBuyer = await detail(pr.id, buyC);
    expect(asBuyer.status).toBe(200);
    expect(asBuyer.body.data.capabilities.approval).toBeNull();
    expect(asBuyer.body.data.pr.now_with).toBe("Purchase team");

    const url = `/dashboard/buyer/purchase-requisitions/${pr.id}`;
    const notes = await prNotifications(pr.id);
    const approvedNotes = notes.filter((n) => n.type === "pr_approved");
    expect(approvedNotes.map((n) => n.recipient_user_id).sort()).toEqual([BUY, REQ].sort());
    for (const n of approvedNotes) expect(n.action_url).toBe(url);
    expect(notes.some((n) => n.recipient_user_id === AP1)).toBe(false);
    // The engine's generic "Approved: …" is not sent on top of the PR's own.
    const generic = await db.any(
      `SELECT id FROM tbl_notifications WHERE recipient_user_id = $1 AND type = 'approval_approved'
          AND additional_data->>'entity_type' = 'PR' AND additional_data->>'entity_id' = $2::text`, [REQ, pr.id]);
    expect(generic).toEqual([]);
  });

  it("two-step-above-threshold: 1,00,000.00 → AP1 then AP2; now_with names AP2 between the steps", async () => {
    const pr = await submitted("100000.00");
    expect((await prRow(pr.id)).estimated_total).toBe("100000.00");
    expect(await stepsOf(pr.instanceId)).toEqual([
      { step_order: 1, status: "PENDING", approvers: [AP1] },
      { step_order: 2, status: "PENDING", approvers: [AP2] },
    ]);
    // AP2 cannot decide step 1.
    expect((await act(ap2C, pr.instanceId, "APPROVE")).status).toBe(400);

    expect((await act(ap1C, pr.instanceId, "APPROVE")).status).toBe(200);
    expect((await prRow(pr.id)).status).toBe("pending_approval");
    const mid = (await detail(pr.id)).body.data;
    expect(mid.pr.now_with).toBe(`Approval step 2: ${names.get(AP2)}`);
    expect((await detail(pr.id, ap2C)).body.data.capabilities.approval.can_approve).toBe(true);

    expect((await act(ap2C, pr.instanceId, "APPROVE")).status).toBe(200);
    expect((await prRow(pr.id)).status).toBe("approved");
    expect((await eventTypes(pr.id)).filter((t) => t === "approved")).toHaveLength(1);
  });

  it("reject: AP1 rejects → rejected (terminal: resubmit 409); requester notified; copy still works", async () => {
    const pr = await submitted("2000.00");
    const res = await act(ap1C, pr.instanceId, "REJECT", "Not in budget");
    expect(res.status).toBe(200);
    expect((await prRow(pr.id)).status).toBe("rejected");
    const events = await eventsOf(pr.id);
    expect(events[events.length - 1]).toMatchObject({
      event_type: "rejected", actor_id: AP1, payload: { instance_id: pr.instanceId, comment: "Not in budget" },
    });
    expect(await recipientsOf(pr.id, "pr_rejected")).toEqual([REQ]);

    const again = await submit(pr.id);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ status: 0, code: "PR_STATE_CONFLICT" });
    expect(await instancesOf(pr.id)).toHaveLength(1);

    const copy = await reqC.post(`/api/v1/pr/${pr.id}/copy`).send({});
    expect(copy.status).toBe(200);
    prIds.push(copy.body.data.id);
  });

  it("sod: the requester holding the approver role is never an approver; their own decision is refused", async () => {
    await dropPrPolicies();
    await makePrPolicy({ steps: [{ source: "ROLE", id: await prRoleId("PR Approver") }] });
    const own = await grantPr(REQ, "PR Approver", { departmentId: ENG });
    try {
      const pr = await submitted("3000.00");
      const [step] = await stepsOf(pr.instanceId);
      expect(step.approvers).toEqual([AP1, AP2].sort((a, b) => a - b));
      expect(step.approvers).not.toContain(REQ);

      const self = await act(reqC, pr.instanceId, "APPROVE");
      expect(self.status).toBe(400);
      expect(self.body.status).toBe(3);
      expect(await prRow(pr.id)).toMatchObject({ status: "pending_approval" });
      expect(await stepsOf(pr.instanceId)).toEqual([step]);
      expect(await eventTypes(pr.id)).not.toContain("approved");

      expect((await act(ap1C, pr.instanceId, "APPROVE")).status).toBe(200);
      expect((await prRow(pr.id)).status).toBe("approved");
    } finally {
      await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [own]);
    }
  });

  it("fail-closed.no-policy: 422 PR_NO_POLICY; still a draft at revision 0, nothing written", async () => {
    await dropPrPolicies();
    const pr = await createPr("1000.00");
    const res = await submit(pr.id);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 0, code: "PR_NO_POLICY" });
    expect(await prRow(pr.id)).toMatchObject({
      status: "draft", revision: 0, estimated_total: null, submitted_at: null, approval_instance_id: null,
    });
    expect(await instancesOf(pr.id)).toEqual([]);
    expect(await eventTypes(pr.id)).toEqual(["created"]);
  });

  it("fail-closed.unresolved: a ROLE step nobody holds → 422 PR_STEP_UNRESOLVED naming the step", async () => {
    await dropPrPolicies();
    const role = await db.one(
      `INSERT INTO tbl_roles (title, description, created_by) VALUES ($1, 'PR approval test role', $2) RETURNING id`,
      [`PR approval unheld ${Date.now()}`, IDS.users.superAdmin]);
    roleIds.push(Number(role.id));
    await db.none(
      `INSERT INTO tbl_role_permissions (role_id, permission_id)
       SELECT $1, id FROM tbl_permissions WHERE resource::text = 'pr' AND action::text IN ('read', 'approve')`,
      [role.id]);
    await makePrPolicy({ steps: [{ source: "USER", id: AP1 }, { source: "ROLE", id: Number(role.id) }] });

    const pr = await createPr("1000.00");
    const res = await submit(pr.id);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("PR_STEP_UNRESOLVED");
    expect(res.body.details).toMatchObject({ step_order: 2 });
    expect(await prRow(pr.id)).toMatchObject({ status: "draft", revision: 0 });
    expect(await instancesOf(pr.id)).toEqual([]);
  });

  it("submit.double: two concurrent submits → one 200, one 409; exactly one instance", async () => {
    const pr = await createPr("1000.00");
    const results = await Promise.all([submit(pr.id), submit(pr.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409).body.code).toBe("PR_STATE_CONFLICT");
    expect(await instancesOf(pr.id)).toHaveLength(1);
    expect((await prRow(pr.id)).revision).toBe(1);
    expect((await eventTypes(pr.id)).filter((t) => t === "approval_started")).toHaveLength(1);
  });

  it("submit.contract-appeared: a rate contract activated after drafting → 422 PR_LINE_ON_CONTRACT; still a draft", async () => {
    const pr = await createPr("1000.00");
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-TEST-PR-6', 'PR submit re-check ARC', $1, $2, $3, $4, $5, 'contract_active',
               NOW() - INTERVAL '30 days', NOW() - INTERVAL '20 days',
               NOW() - INTERVAL '10 days', NOW() + INTERVAL '180 days', $6) RETURNING id`,
      [variant.category_id, A, A1, ENG, IDS.processes.A_P1, REQ]);
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, $2, 1000, 'nos') RETURNING id`,
      [arc.id, variant.variant_id]);
    const contract = await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'active') RETURNING id`,
      [arc.id, IDS.users.vendor_alpha]);
    await db.none(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1, $2, 90, 5, 1000)`, [contract.id, item.id]);
    try {
      const res = await submit(pr.id);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("PR_LINE_ON_CONTRACT");
      expect(res.body.details[0]).toMatchObject({
        line_no: 1, product_variant_id: variant.variant_id, arc_number: "ARC-TEST-PR-6", arc_contract_id: Number(contract.id),
      });
      expect(await prRow(pr.id)).toMatchObject({ status: "draft", revision: 0 });
      expect(await instancesOf(pr.id)).toEqual([]);
    } finally {
      await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contract.id]);
      await db.none(`DELETE FROM tbl_arc_contract WHERE id = $1`, [contract.id]);
      await db.none(`DELETE FROM tbl_arc_item WHERE id = $1`, [item.id]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arc.id]);
      await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arc.id]);
    }
  });

  it("submit.access: only the requester (404 for others), and only while they hold pr.create on the cell (403)", async () => {
    const pr = await createPr("1000.00");
    const asAp1 = await submit(pr.id, {}, ap1C);
    expect(asAp1.status).toBe(404);
    expect(asAp1.body.code).toBe("PR_NOT_FOUND");

    await revokeAllPr(REQ);
    try {
      const res = await submit(pr.id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("PR_FORBIDDEN");
    } finally {
      await grantPr(REQ, "PR Requester", { departmentId: ENG });
    }
    expect(await prRow(pr.id)).toMatchObject({ status: "draft", revision: 0 });
    expect(await instancesOf(pr.id)).toEqual([]);
  });

  it("detail.no-eligible-approver: a current step left with nobody says so on the detail", async () => {
    const pr = await submitted("1000.00");
    // What membership revalidation leaves behind when AP1 loses the approver role (R5: the step stays blocked).
    await db.none(
      `UPDATE tbl_approval_step_approvers SET status = 'REMOVED', removed_at = NOW()
        WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = $1)`,
      [pr.instanceId]);
    const d = (await detail(pr.id)).body.data;
    expect(d.pr.status).toBe("pending_approval");
    expect(d.pr.now_with).toBe(NO_APPROVER_LABEL);
    // Recovery path stays open: the requester can withdraw.
    expect(d.capabilities.can_withdraw).toBe(true);
    expect((await withdraw(pr.id)).status).toBe(200);
    expect((await prRow(pr.id)).status).toBe("draft");
  });
});

// ---------------------------------------------------------------------------
// Withdraw + approver send-back
// ---------------------------------------------------------------------------
describe("PR withdraw and approver send-back", () => {
  it("withdraw: pending_approval → draft; instance CANCELLED; AP1's task is gone and a late approve does nothing; resubmit → revision 2", async () => {
    const pr = await submitted("1000.00");
    const pendingFor = async (client) => ((await client.get(PENDING)).body.data || [])
      .filter((r) => r.entity_type === "PR" && Number(r.entity_id) === pr.id);
    expect(await pendingFor(ap1C)).toHaveLength(1);

    expect((await withdraw(pr.id, ap1C)).status).toBe(404);
    const res = await withdraw(pr.id);
    expect(res.status).toBe(200);
    expect(await prRow(pr.id)).toMatchObject({ status: "draft", revision: 1 });
    const [inst] = await instancesOf(pr.id);
    expect(inst.status).toBe("CANCELLED");
    const events = await eventsOf(pr.id);
    expect(events[events.length - 1]).toMatchObject({
      event_type: "withdrawn", actor_id: REQ, payload: { from_status: "pending_approval", instance_id: inst.id },
    });
    expect(await pendingFor(ap1C)).toEqual([]);
    // The cancelled task is announced to AP1, named by the PR number.
    const moot = await db.any(
      `SELECT title FROM tbl_notifications WHERE recipient_user_id = $1 AND type = 'approval_cancelled'
          AND additional_data->>'approval_instance_id' = $2::text`, [AP1, inst.id]);
    expect(moot).toHaveLength(1);
    expect(moot[0].title).toContain(pr.pr_number);

    // A late approve on the old instance changes nothing.
    const late = await act(ap1C, inst.id, "APPROVE");
    expect(late.body.data?.instance_status).not.toBe("APPROVED");
    expect((await prRow(pr.id)).status).toBe("draft");
    expect(await eventTypes(pr.id)).not.toContain("approved");

    // Withdrawing a draft is a state conflict.
    expect((await withdraw(pr.id)).status).toBe(409);

    const again = await submit(pr.id);
    expect(again.status).toBe(200);
    const row = await prRow(pr.id);
    expect(row).toMatchObject({ status: "pending_approval", revision: 2 });
    const all = await instancesOf(pr.id);
    expect(all.map((i) => i.status)).toEqual(["CANCELLED", "PENDING"]);
    expect(row.approval_instance_id).toBe(all[1].id);
  });

  it("approver send-back: only a pending approver of the current step, with a note; requester edits and resubmits", async () => {
    const pr = await submitted("100000.00");

    const notCurrent = await sendBack(pr.id, "Need a second quote", ap2C);
    expect(notCurrent.status).toBe(403);
    expect(notCurrent.body.code).toBe("PR_FORBIDDEN");
    const asReq = await sendBack(pr.id, "Need a second quote", reqC);
    expect(asReq.status).toBe(403);
    const blank = await sendBack(pr.id, "   ", ap1C);
    expect(blank.status).toBe(422);
    expect(blank.body.code).toBe("PR_VALIDATION");
    const tooLong = await sendBack(pr.id, "x".repeat(2001), ap1C);
    expect(tooLong.status).toBe(422);
    expect(await prRow(pr.id)).toMatchObject({ status: "pending_approval", returned_note: null });

    const res = await sendBack(pr.id, "Need a second quote", ap1C);
    expect(res.status).toBe(200);
    expect(await prRow(pr.id)).toMatchObject({ status: "returned", returned_note: "Need a second quote" });
    expect((await instancesOf(pr.id))[0].status).toBe("CANCELLED");
    const events = await eventsOf(pr.id);
    expect(events[events.length - 1]).toMatchObject({
      event_type: "approval_sent_back", actor_id: AP1,
      payload: { note: "Need a second quote", instance_id: pr.instanceId, step_order: 1 },
    });
    expect(await recipientsOf(pr.id, "pr_returned")).toEqual([REQ]);

    // A second send-back of a returned PR is a state conflict.
    expect((await sendBack(pr.id, "again", ap1C)).status).toBe(409);

    // The requester edits (lines keep their ids) and resubmits: a fresh revision and chain.
    const put = await reqC.put(`/api/v1/pr/${pr.id}`).send(await unchangedBody(pr.id, { title: "Chiller spares (2 quotes)" }));
    expect(put.status).toBe(200);
    const again = await submit(pr.id);
    expect(again.status).toBe(200);
    expect(await prRow(pr.id)).toMatchObject({ status: "pending_approval", revision: 2, returned_note: null });
    expect((await instancesOf(pr.id)).map((i) => i.status)).toEqual(["CANCELLED", "PENDING"]);
  });

  it("send-back: a caller who cannot read the PR gets 404", async () => {
    const pr = await submitted("1000.00");
    const res = await sendBack(pr.id, "nope", rvC);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PR_NOT_FOUND");
    expect((await prRow(pr.id)).status).toBe("pending_approval");
  });
});

// ---------------------------------------------------------------------------
// Post-approval handler, surfaces
// ---------------------------------------------------------------------------
describe("PR approval handlers and surfaces", () => {
  it("handler idempotent: re-running handlePrPostApproval records one approval; a non-APPROVED or stale instance is ignored", async () => {
    const pr = await submitted("1000.00");
    const [pending] = await instancesOf(pr.id);
    // The instance is still PENDING: the handler must not approve the PR.
    await handlePrPostApproval(pr.instanceId, AP1, { instance: pending });
    expect((await prRow(pr.id)).status).toBe("pending_approval");

    expect((await act(ap1C, pr.instanceId, "APPROVE")).status).toBe(200);
    const first = await prRow(pr.id);
    expect(first.status).toBe("approved");
    const [approvedInst] = await instancesOf(pr.id);
    await handlePrPostApproval(pr.instanceId, AP1, { instance: approvedInst });
    await handlePrPostApproval(pr.instanceId, AP1, {});
    expect((await eventTypes(pr.id)).filter((t) => t === "approved")).toHaveLength(1);
    expect((await prRow(pr.id)).approved_at).toEqual(first.approved_at);
    expect(await recipientsOf(pr.id, "pr_approved")).toEqual([BUY, REQ].sort());
    expect((await prNotifications(pr.id)).filter((n) => n.type === "pr_approved")).toHaveLength(2);
  });

  it("cancelApprovalInstance { t }: joins the caller's transaction and notifies only through the returned thunk", async () => {
    const pr = await submitted("1000.00");
    const cancelNotices = () => db.any(
      `SELECT id FROM tbl_notifications WHERE type = 'approval_cancelled'
          AND additional_data->>'approval_instance_id' = $1::text`, [pr.instanceId]);

    // The caller's transaction rolls back after the cancel: nothing sticks, nobody is told.
    await expect(db.tx(async (t) => {
      const res = await cancelApprovalInstance(pr.instanceId, REQ, "rolled back", { t });
      expect(res).toMatchObject({ status: "CANCELLED", notify: expect.any(Function) });
      throw new Error("caller failed after cancelling");
    })).rejects.toThrow("caller failed after cancelling");
    expect((await instancesOf(pr.id))[0].status).toBe("PENDING");
    expect(await cancelNotices()).toEqual([]);

    // Committed: the instance is cancelled, and the approvers hear of it only when the thunk runs.
    const res = await db.tx((t) => cancelApprovalInstance(pr.instanceId, REQ, "committed", { t }));
    expect((await instancesOf(pr.id))[0].status).toBe("CANCELLED");
    expect(await cancelNotices()).toEqual([]);
    await res.notify();
    expect(await cancelNotices()).toHaveLength(1);
    // Put the PR back in step with its instance for cleanup symmetry.
    await db.none(`UPDATE tbl_purchase_requisition SET status = 'draft' WHERE id = $1`, [pr.id]);
  });

  it("pending-approvals surface: AP1's dashboard queue lists the PR with its number, title and link", async () => {
    const pr = await submitted("1000.00");
    const res = await ap1C.get(DASH_PENDING).query({ hotel_ids: String(A1) });
    expect(res.status).toBe(200);
    const item = (res.body.data || []).find((r) => r.entity_type === "PR" && Number(r.entity_id) === pr.id);
    expect(item).toMatchObject({
      entity_type: "PR", pr_id: pr.id, pr_number: pr.pr_number, entity_title: pr.body.title,
      action_url: buyerPrDetail(pr.id),
    });
  });

  it("approval email context: a PR step names the PR number and links to the PR detail", async () => {
    const pr = await submitted("1000.00");
    const [inst] = await instancesOf(pr.id);
    const ctx = approvalStepEmailContext("PR", pr.id, inst.metadata);
    expect(ctx.entityIdentifier).toBe(pr.pr_number);
    expect(approvalActionUrl("PR", pr.id, ctx.extraContext)).toBe(buyerPrDetail(pr.id));
    expect(buyerPrDetail(pr.id)).toBe(`/dashboard/buyer/purchase-requisitions/${pr.id}`);
    expect(entityLabel("PR")).toBe("Purchase Requisition");
    // What the engine sent AP1 for this step: in-app, PR label + number, deep link.
    // The engine fires that notification without awaiting it, so poll briefly.
    const stepNotice = async () => (await db.any(
      `SELECT title FROM tbl_notifications WHERE recipient_user_id = $1 AND action_url = $2`,
      [AP1, buyerPrDetail(pr.id)])).some((n) => n.title.includes("Purchase Requisition") && n.title.includes(pr.pr_number));
    let found = await stepNotice();
    for (let i = 0; i < 20 && !found; i++) {
      await new Promise((r) => setTimeout(r, 100));
      found = await stepNotice();
    }
    expect(found).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Submit → technical review (startReview)
// ---------------------------------------------------------------------------
describe("PR submit → technical review", () => {
  let rvScope;

  beforeAll(async () => {
    rvScope = await grantPr(RV, "PR Technical Reviewer", { departmentId: ENG });
  });

  afterEach(async () => {
    await unmapAll(A);
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [rvScope]);
  });

  const reviewsOf = (prId) => db.any(
    `SELECT rv.id, rv.revision, rv.department_id, rv.status,
            COALESCE((SELECT array_agg(rl.pr_line_id ORDER BY rl.pr_line_id) FROM tbl_pr_review_line rl
                       WHERE rl.review_id = rv.id), '{}') AS line_ids
       FROM tbl_pr_review rv WHERE rv.pr_id = $1 ORDER BY rv.id`, [prId]);

  it("review.start: a mapped category with an eligible reviewer → in_review with one pending review; reviewer notified", async () => {
    await mapCategory(A, variant.category_id, ENG);
    const pr = await createPr("1000.00");
    const res = await submit(pr.id);
    expect(res.status).toBe(200);
    expect(res.body.data.pr.status).toBe("in_review");

    expect(await prRow(pr.id)).toMatchObject({ status: "in_review", revision: 1, estimated_total: "1000.00", approval_instance_id: null });
    expect(await instancesOf(pr.id)).toEqual([]);
    const lineIds = (await db.any(`SELECT id FROM tbl_purchase_requisition_line WHERE pr_id = $1`, [pr.id])).map((l) => l.id);
    const reviews = await reviewsOf(pr.id);
    expect(reviews).toEqual([{ id: expect.any(Number), revision: 1, department_id: ENG, status: "pending", line_ids: lineIds }]);

    const events = await eventsOf(pr.id);
    expect(events.map((e) => e.event_type)).toEqual(["created", "submitted", "review_created"]);
    expect(events[2]).toMatchObject({
      revision: 1, payload: { review_id: reviews[0].id, department_id: ENG, line_ids: lineIds, reviewer_ids: [RV] },
    });
    expect(await recipientsOf(pr.id, "pr_review_task")).toEqual([RV]);
    const [note] = (await prNotifications(pr.id)).filter((n) => n.type === "pr_review_task");
    expect(note.action_url).toBe(buyerPrDetail(pr.id));

    expect((await detail(pr.id)).body.data.pr.now_with).toBe("Technical review: Engineering");

    // Withdraw during review: back to draft, the pending review superseded.
    expect((await withdraw(pr.id)).status).toBe(200);
    expect((await prRow(pr.id)).status).toBe("draft");
    expect((await reviewsOf(pr.id)).map((r) => r.status)).toEqual(["superseded"]);
    const last = (await eventsOf(pr.id)).pop();
    expect(last).toMatchObject({ event_type: "withdrawn", payload: { from_status: "in_review", superseded_review_ids: [reviews[0].id] } });
  });

  it("review.submit-double: two concurrent submits into review → one 200, one 409; one revision, one review", async () => {
    await mapCategory(A, variant.category_id, ENG);
    const pr = await createPr("1000.00");
    const results = await Promise.all([submit(pr.id), submit(pr.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await prRow(pr.id)).revision).toBe(1);
    expect(await reviewsOf(pr.id)).toHaveLength(1);
    expect((await eventTypes(pr.id)).filter((t) => t === "submitted")).toHaveLength(1);
  });

  it("review.no-reviewer: a group whose department has no eligible reviewer → 422 PR_NO_REVIEWER; still a draft", async () => {
    await mapCategory(A, variant.category_id, PROC);
    const pr = await createPr("1000.00");
    const res = await submit(pr.id);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("PR_NO_REVIEWER");
    expect(res.body.details).toMatchObject({ department_id: PROC, department_title: "Procurement" });
    expect(await prRow(pr.id)).toMatchObject({ status: "draft", revision: 0, submitted_at: null });
    expect(await reviewsOf(pr.id)).toEqual([]);
    expect(await eventTypes(pr.id)).toEqual(["created"]);
  });

  it("review.approval-precheck: reviewers exist but the approval chain is broken → 422 before any review is created", async () => {
    await dropPrPolicies();
    await mapCategory(A, variant.category_id, ENG);
    const pr = await createPr("1000.00");
    const res = await submit(pr.id);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("PR_NO_POLICY");
    expect(await prRow(pr.id)).toMatchObject({ status: "draft", revision: 0 });
    expect(await reviewsOf(pr.id)).toEqual([]);
    expect(await recipientsOf(pr.id)).toEqual([]);
  });
});
