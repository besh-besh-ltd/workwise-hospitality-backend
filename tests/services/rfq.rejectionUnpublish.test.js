// Governance invariant: a REJECTED RFQ must never be live to vendors.
//
// Background — why this is not obvious:
//   Publishing does NOT wait for the publish approval. `startApprovalForRFQ`
//   moves the RFQ to status 4 (READY_TO_PUBLISH) at submit time and arms an
//   EventBridge schedule for `tender_publish_date`, recording the lifecycle
//   event PUBLISH_WITHOUT_APPROVAL ("Publishing proceeded without waiting for
//   approval completion"). The approval instance stays PENDING.
//
//   `handleRFQRejection` then unwinds with `UPDATE tbl_rfq SET status = 1`.
//   status=1 + is_published=0 IS this system's draft state (that is exactly how
//   a new RFQ is inserted — rfqModel.js, `is_published 0, status 1`), so the
//   status write alone is right. What it never did was disarm the publish
//   pipeline:
//     - the EventBridge schedule created at submit time stays armed, and
//     - `publishRfqById` explicitly accepts status 1 as publishable
//       (cronManager.js: `if (rfq.status !== 4 && rfq.status !== 1) skip`).
//   So the scheduler fires after the rejection and publishes the rejected RFQ:
//   status=1 + is_published=1, which is the "live to vendors" predicate used by
//   rfqModel.getRfqByUser, vendorDashboardModel and dashboardModel.
//
//   `handleRFQRejection` also never cleared `is_published`, so if an RFQ were
//   already live when the rejection landed it would stay live. That second
//   sequence is currently blocked upstream by the published-RFQ write guard in
//   generalModel.submitApprovalAction — locked in below so the guard cannot be
//   removed without this suite going red.
//
// Per CONVENTIONS.md the production functions are driven end to end: the real
// approval engine (`executeApprovalAction`), the real `forcePublishRfq`
// controller, and the real vendor/buyer listing queries. Email transport and
// the AWS Scheduler SDK are mocked because they are network edges, not logic —
// the Scheduler mock is also the probe for the schedule teardown.
//
// Run isolated (two sessions share one test DB):
//   TEST_RUN_ID=<unique> npm test -- --testPathPatterns "rejectionUnpublish"

import { describe, it, expect, afterAll, beforeEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";

// --- Mocks (installed BEFORE the modules under test are imported) -----------

jest.unstable_mockModule(
  "../../app/helper/sendEmailFunctions/approvalEmails.js",
  () => ({
    sendRfqCreationNotification: async () => {},
    sendApprovalStepNotification: async () => {},
    sendRfqReadyToPublishNotification: async () => {},
    sendRfqPublishedNotification: async () => {},
    sendVendorRfqNotification: async () => {},
    sendVendorAutoAddedToRfqNotification: async () => {},
    sendVendorBulkRfqJoinNotification: async () => {},
    sendRfqClosedHeadsUpNotification: async () => {},
    sendApprovalCancelledNotification: async () => {},
    sendPolicyChangeNotification: async () => {},
    sendApproverRemovedNotification: async () => {},
    sendApprovalStandsNotification: async () => {},
    sendApproverAddedMidFlightNotification: async () => {},
  })
);

jest.unstable_mockModule(
  "../../app/helper/sendEmailFunctions/rfqPublishFailureEmail.js",
  () => ({ sendRfqPublishFailureToCreator: async () => true })
);

// The AWS Scheduler SDK is the only network edge on the schedule-teardown path.
// Capture the commands so we can assert the rejection actually disarms the
// EventBridge schedule it created at submit time.
const schedulerCommands = [];
jest.unstable_mockModule("@aws-sdk/client-scheduler", () => ({
  SchedulerClient: class {
    send = async (cmd) => {
      schedulerCommands.push(cmd?.constructor?.name || "Unknown");
      return {};
    };
  },
  CreateScheduleCommand: class CreateScheduleCommand {},
  UpdateScheduleCommand: class UpdateScheduleCommand {},
  DeleteScheduleCommand: class DeleteScheduleCommand {},
  GetScheduleCommand: class GetScheduleCommand {},
  ListSchedulesCommand: class ListSchedulesCommand {},
  CreateScheduleGroupCommand: class CreateScheduleGroupCommand {},
}));

const { default: rfqController } = await import("../../app/controllers/rfq/rfqController.js");
const { createApprovalInstance } = await import("../../app/models/generalModel.js");
const { default: rfqModel } = await import("../../app/models/rfqModel.js");
const { default: dashboardModel } = await import("../../app/models/dashboardModel.js");
const { rejectStep, getInstanceState } = await import("../helpers/approval.js");
const { makeRFQ } = await import("../factories/rfq.js");
const { makeRfqVisibleToDashboard, inviteVendors, cleanupRfqs } =
  await import("../helpers/dashboardSeed.js");

// --- Scaffolding ------------------------------------------------------------

const CREATOR = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;

/** Minimal Express req/res that captures the status/body the controller sends. */
function mockExpress(req) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    send(body) { calls.body = body; return this; },
  };
  return { req: { ...req }, res, calls };
}

const inserted = { rfqIds: [], instanceIds: [] };

async function seedSubmittedRfq({ status = 4, is_published = 0, tender_publish_date } = {}) {
  const { rfq_id, rfq_no } = await makeRfqVisibleToDashboard(db, {
    createdBy: CREATOR,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: IDS.processes.A_P1,
    status,
    is_published,
    ...(tender_publish_date ? { tender_publish_date } : {}),
  });
  inserted.rfqIds.push(rfq_id);

  // The vendor was snapshotted onto the RFQ at creation — this is what makes
  // the RFQ appear on the vendor's listing once it publishes.
  await inviteVendors(db, { rfq_id, vendor_ids: [VENDOR] });

  // Real approval instance from the real policy (steps + approver rows and
  // all), exactly as startApprovalForRFQ creates it at submit time.
  const { instance } = await createApprovalInstance({
    entity_type: "RFQ",
    entity_id: rfq_id,
    hospitality_company_id: IDS.hospitality.A,
    hotel_id: IDS.hotels.A1,
    department_id: null,
    process_id: IDS.processes.A_P1,
    approval_policy_id: IDS.policies.A1_P1_RFQ,
    initiated_by: CREATOR,
  });
  inserted.instanceIds.push(instance.id);

  return { rfq_id, rfq_no, instanceId: instance.id };
}

async function firstPendingApprover(instanceId) {
  const state = await getInstanceState(instanceId);
  const step = state.steps.find((s) => s.approvers.some((a) => a.status === "PENDING"));
  return step.approvers.find((a) => a.status === "PENDING").approver_user_id;
}

/** The vendor's own RFQ listing — the surface a vendor bids from. */
async function vendorSeesRfq(rfqId) {
  const rows = await rfqModel.getRfqByUser(100, 0, VENDOR, {});
  return rows.some((r) => Number(r.id) === Number(rfqId));
}

/** The creator's Drafts widget — where a rejected RFQ must land. */
async function creatorSeesInDrafts(rfqId) {
  const data = await dashboardModel.getMyDraftsData(
    IDS.companies.A,
    CREATOR,
    [IDS.hotels.A1]
  );
  return (data.items || []).some((r) => Number(r.id) === Number(rfqId));
}

async function rfqState(rfqId) {
  return db.one(`SELECT status, is_published FROM tbl_rfq WHERE id = $1`, [rfqId]);
}

async function resetState() {
  if (inserted.instanceIds.length) {
    await db.none(
      `DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`,
      [inserted.instanceIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_step_approvers
       WHERE approval_instance_step_id IN (
         SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])
       )`,
      [inserted.instanceIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`,
      [inserted.instanceIds]
    );
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [
      inserted.instanceIds,
    ]);
    inserted.instanceIds.length = 0;
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [
      inserted.rfqIds,
    ]);
    await db.none(`DELETE FROM tbl_quote_activity WHERE rfq_id = ANY($1::int[])`, [
      inserted.rfqIds,
    ]);
    await db.none(
      `DELETE FROM tbl_vendor_rfq_tokens_non_login
       WHERE rfq_no IN (SELECT rfq_no FROM tbl_rfq WHERE id = ANY($1::int[]))`,
      [inserted.rfqIds]
    );
    await cleanupRfqs(db, inserted.rfqIds);
    inserted.rfqIds.length = 0;
  }
}

beforeEach(async () => {
  schedulerCommands.length = 0;
  await resetState();
});

afterAll(async () => {
  await resetState();
  await closeDb();
});

// --- The reachable sequence -------------------------------------------------

describe("rejected RFQ must not be able to reach vendors", () => {
  it("leaves the RFQ off the vendor listing and disarms the armed publish schedule", async () => {
    const { rfq_id, instanceId } = await seedSubmittedRfq({ status: 4 });

    // Approver rejects while the RFQ sits at READY_TO_PUBLISH with an
    // EventBridge schedule armed for tender_publish_date.
    const approver = await firstPendingApprover(instanceId);
    const result = await rejectStep(instanceId, approver, { comment: "scope wrong" });
    expect(result.instance_status).toBe("REJECTED");

    // Not live now...
    expect(await vendorSeesRfq(rfq_id)).toBe(false);
    const after = await rfqState(rfq_id);
    expect(after.is_published).toBe(0);

    // ...and not live later: the schedule that would have published it must be
    // deleted. Without this the schedule fires post-rejection and publishRfqById
    // publishes it (it accepts status 1), putting a REJECTED RFQ on the vendor
    // listing. This assertion IS the fix for that.
    expect(schedulerCommands).toContain("DeleteScheduleCommand");
  });

  it("refuses force publish for a rejected RFQ even after its publish time has passed", async () => {
    const yesterday = new Date(Date.now() - 86400_000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    const { rfq_id, instanceId } = await seedSubmittedRfq({
      status: 4,
      tender_publish_date: yesterday,
    });
    const approver = await firstPendingApprover(instanceId);
    await rejectStep(instanceId, approver, { comment: "rejected" });

    // Force publish is the creator's manual escape hatch for a stuck RFQ. It
    // must not become a way to publish something an approver rejected.
    const { req, res, calls } = mockExpress({
      params: { id: String(rfq_id) },
      user: { id: CREATOR },
    });
    await rfqController.forcePublishRfq(req, res, () => {});

    expect(calls.status).toBe(400);
    expect(await vendorSeesRfq(rfq_id)).toBe(false);
    expect((await rfqState(rfq_id)).is_published).toBe(0);
  });

  it("returns the rejected RFQ to the creator's Drafts, not just out of sight", async () => {
    const { rfq_id, instanceId } = await seedSubmittedRfq({ status: 4 });
    const approver = await firstPendingApprover(instanceId);
    await rejectStep(instanceId, approver, { comment: "needs rework" });

    // is_published=0 AND status NOT IN (5,2) is the Drafts predicate. A fix
    // that hides the RFQ from vendors by closing/withdrawing it would also
    // hide it from the buyer — that is not a fix.
    const state = await rfqState(rfq_id);
    expect(state.is_published).toBe(0);
    expect([5, 2]).not.toContain(state.status);
    expect(await creatorSeesInDrafts(rfq_id)).toBe(true);
  });
});

// --- The already-published sequence (guarded upstream) ----------------------

describe("rejecting an RFQ that already published", () => {
  it("is refused by the approval engine, leaving the live RFQ approvable-only", async () => {
    const { rfq_id, instanceId } = await seedSubmittedRfq({ status: 1, is_published: 1 });
    expect(await vendorSeesRfq(rfq_id)).toBe(true);

    const approver = await firstPendingApprover(instanceId);
    await expect(
      rejectStep(instanceId, approver, { comment: "too late" })
    ).rejects.toThrow(/already been published/i);

    // The rejection never landed, so the RFQ is untouched — importantly it is
    // NOT left as a live RFQ carrying a REJECTED approval.
    const after = await rfqState(rfq_id);
    expect(after.status).toBe(1);
    expect(after.is_published).toBe(1);
    const state = await getInstanceState(instanceId);
    expect(state.instance.status).toBe("PENDING");
  });
});

// --- Residual gap (out of scope here) ---------------------------------------

describe("defence in depth: the publisher itself should refuse a rejected RFQ", () => {
  it.todo(
    "publishRfqById(rfqId, rfq_no, 'scheduler') on an RFQ whose latest publish " +
      "approval is REJECTED must skip instead of publishing. Today it publishes: " +
      "its state check is `if (rfq.status !== 4 && rfq.status !== 1) skip`, and a " +
      "rejected RFQ is status 1. Rejection now deletes the schedule so nothing " +
      "invokes it, but that teardown is best-effort (a swallowed AWS failure " +
      "leaves the schedule armed). The guard belongs in cronManager.publishRfqById, " +
      "which this change deliberately does not touch."
  );
});
