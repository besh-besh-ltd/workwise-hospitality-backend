// A PO approval taken from any surface must leave the stored PO PDF truthful.
//
// CONFIRMED DEFECT, reproduced from a real reported case (RFQ 536375, PO 483,
// approval instance 4218). Both approvers are APPROVED in the database:
//
//   step 1  Varun Sahani   APPROVED  2026-08-18 12:06:24 UTC
//   step 2  Vishal Kamat   APPROVED  2026-08-19 06:03:56 UTC
//
// …yet the downloaded PO printed Vishal as "Invited". The PDF is a stored
// artefact (`po_pdf_url` -> S3), not rendered on demand, so its approver table
// only changes when something rewrites the file. Regeneration lived solely in
// the dedicated PO approval endpoint, on the stated assumption that it was
// "the canonical PO approval surface". It is not: the RFQ Lifecycle Journey and
// the generic action endpoint both approve POs through executeApprovalAction.
// Step 1 went through the dedicated endpoint and rewrote the PDF; step 2 went
// through the dispatcher a day later and did not.
//
// The rule these tests pin: executeApprovalAction regenerates the PO document on
// every APPROVE, before the post-action that emails it, and never lets a
// regeneration failure surface as a failed approval.

import { jest } from "@jest/globals";

const regenCalls = [];
const dispatchCalls = [];
let instanceRow = null;
let actionResult = null;
let regenImpl = async (poId) => { regenCalls.push(poId); return "https://s3/po.pdf"; };

jest.unstable_mockModule("../../app/models/generalModel.js", () => ({
  submitApprovalAction: async () => actionResult,
  getApprovalInstanceById: async () => instanceRow,
}));

jest.unstable_mockModule("../../app/models/purchaseOrderModel.js", () => ({
  regeneratePODocument: (...a) => regenImpl(...a),
}));

// The post-action must observe a PDF that already includes this approver.
jest.unstable_mockModule("../../app/controllers/po/purchaseOrderController.js", () => ({
  handlePOPostApproval: async () => { dispatchCalls.push({ after: regenCalls.length }); },
  handlePORejectionByInstance: async () => { dispatchCalls.push({ after: regenCalls.length }); },
}));

jest.unstable_mockModule("../../app/services/notificationService.js", () => ({
  dispatch: async () => {},
}));

const { executeApprovalAction } = await import("../../app/services/approvalActionService.js");

const PO_INSTANCE = { id: 4218, entity_type: "PO", entity_id: 483, initiated_by: 1 };
const RFQ_INSTANCE = { id: 99, entity_type: "RFQ", entity_id: 7, initiated_by: 1 };

const approve = (extra = {}) =>
  executeApprovalAction({
    approval_instance_id: 4218,
    approver_user_id: 42,
    action: "APPROVE",
    comment: "",
    ...extra,
  });

beforeEach(() => {
  regenCalls.length = 0;
  dispatchCalls.length = 0;
  instanceRow = PO_INSTANCE;
  actionResult = { status: "APPROVED", instance_status: "APPROVED" };
  regenImpl = async (poId) => { regenCalls.push(poId); return "https://s3/po.pdf"; };
});

describe("PO document regeneration on approval", () => {
  it("regenerates for the PO the instance belongs to", async () => {
    await approve();
    expect(regenCalls).toEqual([483]);
  });

  it("regenerates on an intermediate step, not only the terminal one", async () => {
    // Vishal's case in reverse: step recorded, instance still PENDING. The PDF
    // lists every step, so it must be rewritten now — not only at the end.
    actionResult = { status: "APPROVED", instance_status: "PENDING", step_status: "PENDING" };
    await approve();
    expect(regenCalls).toEqual([483]);
  });

  it("regenerates BEFORE the post-action that emails the PDF", async () => {
    await approve();
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].after).toBe(1); // regen had already run
  });

  it("does not regenerate for a non-PO entity", async () => {
    instanceRow = RFQ_INSTANCE;
    await approve();
    expect(regenCalls).toEqual([]);
  });

  it("does not regenerate on REJECT", async () => {
    actionResult = { status: "REJECTED", instance_status: "REJECTED" };
    await executeApprovalAction({
      approval_instance_id: 4218, approver_user_id: 42, action: "REJECT", comment: "no",
    });
    expect(regenCalls).toEqual([]);
  });

  it("a regeneration failure never fails the committed approval", async () => {
    regenImpl = async () => { throw new Error("S3 unreachable"); };
    await expect(approve()).resolves.toMatchObject({ instance_status: "APPROVED" });
  });
});
