// ARC negotiation approval emails must open the round's approve page on its
// own rate contract.
//
// The defect: approvalStepEmailContext copied only RFQ- and PO-shaped keys out
// of the instance metadata. An ARC_NEGOTIATION instance's entity_id is the
// ROUND id, so with metadata.arc_id and metadata.round_id dropped the link
// resolver fell back to /dashboard/buyer/rate-contracts/<round id>?stage=commercial
// — another rate contract, or none. The approver the round was waiting on
// (Phileein, 22 Oct 2026) could not reach it from the email or the bell. Found
// in the live E2E of that flow: round 6 on ARC 2 linked to /rate-contracts/6.
//
// Every ARC_NEGOTIATION instance carries metadata.round_id and metadata.arc_id
// (arcNegotiationController.createRound).
//
// Product-level: drives the real sendApprovalStepNotification with the context
// the engine builds; only the mail transport and in-app dispatch are mocked.

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

const { sendApprovalStepNotification } = await import(
  "../../app/helper/sendEmailFunctions/approvalEmails.js"
);
const { approvalStepEmailContext } = await import("../../app/helper/approvalEmailContext.js");

const ARC_ID = 2;
const ROUND_ID = 6;
const ROUND_METADATA = {
  round_id: ROUND_ID,
  arc_id: ARC_ID,
  round_number: 2,
  end_date: "2026-10-24T13:50:00.000Z",
  creator_remarks: "Asking both vendors to come down to 82",
};

const approvers = [{ user_id: 924, user_name: "Approver", user_email: "approver@example.invalid" }];

async function send(entityType, entityId, metadata) {
  const { entityIdentifier, extraContext } = approvalStepEmailContext(entityType, entityId, metadata);
  await sendApprovalStepNotification({
    entityType, entityId, entityIdentifier, stepOrder: 1, totalSteps: 1,
    initiatorName: "Initiator", approvers, extraContext,
  });
  // the send is fire-and-forget internally; let it settle
  await new Promise((r) => setTimeout(r, 20));
}

describe("ARC negotiation approval email routing", () => {
  beforeEach(() => { sentMails.length = 0; dispatched.length = 0; });

  it("links the approver to the round's approve page on its own rate contract", async () => {
    await send("ARC_NEGOTIATION", ROUND_ID, ROUND_METADATA);
    const approvePage = `/dashboard/buyer/rate-contracts/${ARC_ID}/negotiation/${ROUND_ID}/approve`;
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0].html).toContain(approvePage);
    expect(sentMails[0].html).not.toContain(`/rate-contracts/${ROUND_ID}?`);
    expect(JSON.stringify(dispatched[0])).toContain(approvePage);
  });
});
