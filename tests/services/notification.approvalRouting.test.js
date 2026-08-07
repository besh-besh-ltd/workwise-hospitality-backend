// Approval notifications for ARC and MR.
//
// The defect this guards: the approval engine's entity→link and entity→label
// maps covered seven types (RFQ, TENDER, TECHNICAL, NEGOTIATION,
// NEGOTIATION_QUOTE, ARC, PO) while twelve were live in production. Every
// ARC_PUBLISH / ARC_TECH / ARC_COMMITTEE / ARC_NEGOTIATION / ARC_AMENDMENT and
// MR approval therefore fell through to the defaults and the approver received:
//
//   title:      "Action required: Approve ARC_PUBLISH #ID-12"   ← raw enum
//   actionUrl:  "<host>/dashboard"                              ← "Coming Soon"
//
// Measured on staging: 20 such notifications, spanning five entity types.
//
// Product-level: this drives the real `sendApprovalStepNotification` and
// asserts on what lands in the approver's inbox. Only the mail transport and
// the in-app dispatch are mocked, so the routing under test is production code.

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

const APPROVER = [
  { user_id: 42, user_name: "Asha Menon", user_email: "asha@example.com" },
];

const stepArgs = (entityType, entityId, extraContext = {}) => ({
  entityType,
  entityId,
  entityIdentifier: String(entityId),
  stepOrder: 1,
  totalSteps: 1,
  initiatorName: "Kushal Shah",
  approvers: APPROVER,
  extraContext,
});

const ctaHref = (mail) => {
  const matches = [...String(mail.html).matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  return matches.find((href) => href.includes("/dashboard")) || null;
};

beforeEach(() => {
  sentMails.length = 0;
  dispatched.length = 0;
});

describe("ARC approvals land on the right stage of the right contract", () => {
  const cases = [
    ["ARC_PUBLISH", 12, { arc_id: 12 }, "/dashboard/buyer/rate-contracts/12?stage=overview"],
    ["ARC_TECH", 17, { arc_id: 17 }, "/dashboard/buyer/rate-contracts/17?stage=technical"],
    ["ARC_COMMERCIAL", 17, { arc_id: 17 }, "/dashboard/buyer/rate-contracts/17?stage=commercial"],
    ["ARC_COMMITTEE", 18, { arc_id: 18 }, "/dashboard/buyer/rate-contracts/18?stage=awarding"],
    ["ARC_AMENDMENT", 4, { arc_id: 6 }, "/dashboard/buyer/rate-contracts/6?stage=active"],
    [
      "ARC_NEGOTIATION",
      169,
      { arc_id: 18, round_id: 169 },
      "/dashboard/buyer/rate-contracts/18/negotiation/169/approve",
    ],
    ["MR", 812, { mr_id: 812 }, "/dashboard/buyer/material-requisitions/812"],
  ];

  it.each(cases)("%s → %s", async (entityType, entityId, ctx, expected) => {
    await sendApprovalStepNotification(stepArgs(entityType, entityId, ctx));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].actionUrl).toBe(expected);
    // The mail carries the same destination, absolutised for an inbox.
    expect(ctaHref(sentMails[0])).toBe(`http://localhost:3000${expected}`);
  });

  it.each(cases)("%s never falls back to the bare dashboard", async (entityType, entityId, ctx) => {
    await sendApprovalStepNotification(stepArgs(entityType, entityId, ctx));

    expect(dispatched[0].actionUrl).not.toBe("/dashboard");
    expect(ctaHref(sentMails[0])).not.toMatch(/\/dashboard$/);
  });
});

describe("approval copy names the thing being approved", () => {
  it.each([
    ["ARC_PUBLISH", "Rate Contract Publication"],
    ["ARC_TECH", "Rate Contract Technical Evaluation"],
    ["ARC_COMMITTEE", "Rate Contract Committee Decision"],
    ["ARC_AMENDMENT", "Rate Contract Amendment"],
    ["ARC_NEGOTIATION", "Rate Contract Negotiation"],
    ["MR", "Material Requisition"],
  ])("%s reads as '%s', not the raw enum", async (entityType, label) => {
    await sendApprovalStepNotification(stepArgs(entityType, 12, { arc_id: 12, mr_id: 12 }));

    expect(dispatched[0].title).toContain(label);
    expect(dispatched[0].title).not.toContain(entityType);
    expect(dispatched[0].title).not.toMatch(/_/);
  });

  it("never shows the #ID- placeholder when a real identifier exists", async () => {
    await sendApprovalStepNotification({
      ...stepArgs("ARC_PUBLISH", 12, { arc_id: 12 }),
      entityIdentifier: "ARC/2026/0012",
    });

    expect(dispatched[0].title).toContain("ARC/2026/0012");
  });
});

describe("an unroutable approval still reaches the approver", () => {
  it("falls back to the buyer home rather than a wrong record", async () => {
    await sendApprovalStepNotification(stepArgs("SOMETHING_UNMAPPED", 5, {}));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].actionUrl).toBe("/dashboard/buyer");
    // Not the Coming Soon placeholder.
    expect(dispatched[0].actionUrl).not.toBe("/dashboard");
  });

  it("still gives it a readable label", async () => {
    await sendApprovalStepNotification(stepArgs("SOMETHING_UNMAPPED", 5, {}));
    expect(dispatched[0].title).not.toContain("SOMETHING_UNMAPPED");
  });
});

describe("in-app rows stay environment-portable", () => {
  it("stores a relative path so the row works wherever it is opened", async () => {
    for (const [type, id, ctx] of [
      ["ARC_PUBLISH", 12, { arc_id: 12 }],
      ["MR", 812, { mr_id: 812 }],
      ["PO", 61, { po_id: 61, rfq_id: 359 }],
      ["RFQ", 354, { rfq_id: 354 }],
    ]) {
      dispatched.length = 0;
      await sendApprovalStepNotification(stepArgs(type, id, ctx));
      expect(dispatched[0].actionUrl.startsWith("/")).toBe(true);
      expect(dispatched[0].actionUrl).not.toMatch(/^https?:/);
      expect(dispatched[0].actionUrl).not.toMatch(/undefined/);
    }
  });
});
