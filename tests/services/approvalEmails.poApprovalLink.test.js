// PO approval emails must open the PO, not the RFQ.
//
// The defect: the approval engine built the email context for every entity
// from RFQ-shaped metadata. For a PO instance it never passed `po_id`, so the
// link resolver fell back to the RFQ workspace
// (/dashboard/buyer/rfq-management-details?...&stage=purchase-order) instead of
// /dashboard/buyer/purchase-orders/:id — the page that actually has Approve on
// it. And the display identifier preferred `rfq_no`, so the subject read
// "Approve Purchase Order #536563" (the RFQ number) instead of the PO number.
// On a phone, where the approver taps straight through from the email, that is
// the difference between one tap and hunting through the RFQ workspace.
//
// Every PO approval instance on production carries metadata.po_id (== entity_id)
// and metadata.po_number (561/561 verified 2026-09-30).
//
// Product-level: drives the real sendApprovalStepNotification with the context
// the engine now builds; only the mail transport and in-app dispatch are mocked.

import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const sentMails = [];
const dispatched = [];

jest.unstable_mockModule("../../app/helper/common.js", () => ({
  sendMail: (opts) => {
    sentMails.push(opts);
    return Promise.resolve({ messageId: "<captured>" });
  },
  logError: () => {},
}));

jest.unstable_mockModule("../../app/services/notificationService.js", () => ({
  dispatch: async (args) => {
    dispatched.push(args);
  },
  resolveRecipientUserIds: async (recipients = []) =>
    recipients.map((r) => r.user_id || r.id).filter(Boolean),
}));

const { sendApprovalStepNotification, approvalStepEmailContext } = await import(
  "../../app/helper/sendEmailFunctions/approvalEmails.js"
);

const PO_METADATA = {
  po_id: 626,
  rfq_id: 1028,
  rfq_no: 536563,
  is_tender: 0,
  po_number: "138898",
  vendor_id: 926,
  total_value: 6535100,
};

const approvers = [{ user_id: 125, user_name: "Approver", user_email: "approver@example.invalid" }];

async function send(entityType, entityId, metadata) {
  const { entityIdentifier, extraContext } = approvalStepEmailContext(entityType, entityId, metadata);
  await sendApprovalStepNotification({
    entityType, entityId, entityIdentifier, stepOrder: 1, totalSteps: 2,
    initiatorName: "Initiator", approvers, extraContext,
  });
  // the send is fire-and-forget internally; let it settle
  await new Promise((r) => setTimeout(r, 20));
}

describe("PO approval email routing", () => {
  beforeEach(() => { sentMails.length = 0; dispatched.length = 0; });

  it("links the approver to the PO detail page and names the PO number", async () => {
    await send("PO", 626, PO_METADATA);
    expect(sentMails).toHaveLength(1);
    const { subject, html } = sentMails[0];
    expect(html).toContain("/dashboard/buyer/purchase-orders/626");
    expect(html).not.toContain("stage=purchase-order");
    expect(subject).toContain("#138898");
    expect(subject).not.toContain("536563");
    const inApp = dispatched[0];
    expect(JSON.stringify(inApp)).toContain("/dashboard/buyer/purchase-orders/626");
  });

  it("still falls back to the RFQ workspace when a legacy PO instance has no po_id", async () => {
    const { po_id, ...legacy } = PO_METADATA;
    const ctx = approvalStepEmailContext("PO", 626, legacy);
    // entity_id of a PO instance IS the PO id, so we still route to the PO.
    expect(ctx.extraContext.po_id).toBe(626);
  });

  it("leaves RFQ-family identifiers and context unchanged", () => {
    const ctx = approvalStepEmailContext("NEGOTIATION_QUOTE", 5941, { rfq_id: 974, rfq_no: 536509, rfq_title: "Linen", product_name: "Towel" });
    expect(ctx.entityIdentifier).toBe(536509);
    expect(ctx.extraContext).toEqual({ rfq_id: 974, rfq_title: "Linen", end_date: null, product_name: "Towel", company_name: "", hotel_name: "" });
  });
});
