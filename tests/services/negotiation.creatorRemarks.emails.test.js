// REQ-0026: creator remarks reach the approvers (approval-step email and
// in-app notification) and the creator / "round approved" internal emails,
// and never the vendor invitation. Remarks are untrusted text: HTML is
// escaped and line breaks survive.
//
// Real email builders are driven; only the mail transport and the in-app
// notification dispatch are replaced so the HTML can be read.

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
const {
  sendNegotiationRoundCreatedNotification,
  sendNegotiationRoundApprovedNotification,
  sendNegotiationRoundVendorNotification,
} = await import("../../app/helper/sendEmailFunctions/negotiationEmails.js");
const { escapeHtmlMultiline } = await import("../../app/helper/negotiation/roundRemarks.js");
const { approvalStepEmailContext } = await import("../../app/helper/approvalEmailContext.js");

const RAW = "<b>x</b>\nline2";
const ESCAPED = "&lt;b&gt;x&lt;/b&gt;<br>line2";
const APPROVER = [{ user_id: 42, user_name: "Asha", user_email: "asha@example.com" }];

const stepArgs = (entityType, extra = {}) => ({
  entityType,
  entityId: 900,
  entityIdentifier: "536001",
  stepOrder: 1,
  totalSteps: 2,
  initiatorName: "Ravi",
  approvers: APPROVER,
  extraContext: { rfq_id: 77, rfq_title: "Linen", ...extra },
});

const round = (extra = {}) => ({
  id: 5, rfq_id: 77, round_number: 2, end_date: "2026-11-01T10:00:00Z", ...extra,
});
const initiator = { name: "Ravi", email: "ravi@example.com" };

beforeEach(() => {
  sentMails.length = 0;
  dispatched.length = 0;
});

describe("escapeHtmlMultiline", () => {
  it("escapes all five characters and converts CRLF, CR and LF to <br>", () => {
    expect(escapeHtmlMultiline(`& < > " '\r\na\rb\nc`)).toBe(
      "&amp; &lt; &gt; &quot; &#39;<br>a<br>b<br>c"
    );
  });
});

describe("approval-step email", () => {
  it("shows escaped creator remarks for a NEGOTIATION instance", async () => {
    const { extraContext } = approvalStepEmailContext("NEGOTIATION", 900, { rfq_id: 77, creator_remarks: RAW });
    await sendApprovalStepNotification({ ...stepArgs("NEGOTIATION"), extraContext });
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0].html).toContain("Creator's remarks:");
    expect(sentMails[0].html).toContain(ESCAPED);
    expect(sentMails[0].html).not.toContain("<b>x</b>");
    // in-app notification carries it too
    expect(dispatched[0].data.creator_remarks).toBe(RAW);
  });

  it("shows remarks for an ARC_NEGOTIATION instance", async () => {
    await sendApprovalStepNotification(stepArgs("ARC_NEGOTIATION", { creator_remarks: RAW }));
    expect(sentMails[0].html).toContain(ESCAPED);
  });

  it("omits the row when remarks are null", async () => {
    await sendApprovalStepNotification(stepArgs("NEGOTIATION", { creator_remarks: null }));
    expect(sentMails[0].html).not.toContain("Creator's remarks");
  });

  it("does not show remarks for other entity types", async () => {
    await sendApprovalStepNotification(stepArgs("NEGOTIATION_QUOTE", { creator_remarks: RAW }));
    expect(sentMails[0].html).not.toContain("Creator's remarks");
  });
});

describe("internal round emails", () => {
  it("round-approved and creator emails show remarks", async () => {
    await sendNegotiationRoundApprovedNotification({
      round: round({ creator_remarks: RAW }), rfqNo: "536001", productName: "Towel", initiator,
    });
    await sendNegotiationRoundCreatedNotification({
      round: round({ creator_remarks: RAW }), rfqNo: "536001", productName: "Towel", initiator,
    });
    expect(sentMails).toHaveLength(2);
    for (const m of sentMails) {
      expect(m.html).toContain("Creator's remarks:");
      expect(m.html).toContain(ESCAPED);
    }
  });

  it("omit the row when the round has no remarks", async () => {
    await sendNegotiationRoundApprovedNotification({
      round: round({ creator_remarks: null }), rfqNo: "536001", productName: "Towel", initiator,
    });
    expect(sentMails[0].html).not.toContain("Creator's remarks");
  });

  it("vendor invitation email never contains the remarks text", async () => {
    await sendNegotiationRoundVendorNotification({
      round: round({ creator_remarks: "SECRET-INTERNAL-NOTE" }),
      rfqNo: "536001",
      productName: "Towel",
      vendors: [{ name: "Vend", email: "v@example.com", token: "tok" }],
    });
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0].html).not.toContain("SECRET-INTERNAL-NOTE");
    expect(sentMails[0].html).not.toContain("Creator's remarks");
  });
});
