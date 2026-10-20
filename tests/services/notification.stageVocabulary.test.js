// One vocabulary for approval stages across RFQ and ARC, with Unit/Group ARC
// qualifiers. The frontend reads the same copy table; the backend's emails,
// in-app notifications and error messages must say the same words.

import { describe, it, expect, afterAll, beforeEach, jest } from "@jest/globals";

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

const { stageLabel, entityLabel, ENTITY_LABELS, STAGE_LABELS } = await import(
  "../../app/services/notificationLinks.js"
);
const { sendApprovalStepNotification } = await import(
  "../../app/helper/sendEmailFunctions/approvalEmails.js"
);
const { withTx, closeDb } = await import("../setup/db.js");
const { createApprovalInstance } = await import("../../app/models/generalModel.js");
const { IDS } = await import("../fixtures/ids.js");

afterAll(async () => {
  await closeDb();
});

beforeEach(() => {
  sentMails.length = 0;
  dispatched.length = 0;
});

describe("stageLabel", () => {
  it.each([
    ["RFQ", "RFQ Approval"],
    ["TENDER", "Tender Approval"],
    ["TECHNICAL", "Technical Approval"],
    ["NEGOTIATION", "Negotiation Round Approval"],
    ["NEGOTIATION_QUOTE", "Final Vendor Approval"],
    ["ARC", "Unit ARC · Publish Approval"],
    ["ARC_PUBLISH", "Unit ARC · Publish Approval"],
    ["ARC_TECH", "Unit ARC · Technical Approval"],
    ["ARC_NEGOTIATION", "Unit ARC · Negotiation Round Approval"],
    ["ARC_COMMITTEE", "Unit ARC · Committee Approval"],
    ["ARC_AMENDMENT", "Unit ARC · Amendment Approval"],
  ])("%s → %s", (type, label) => {
    expect(stageLabel(type)).toBe(label);
  });

  it("qualifies Group ARC by flag or by ARC_GROUP_* type", () => {
    expect(stageLabel("ARC_TECH", { isGroup: true })).toBe("Group ARC · Technical Approval");
    expect(stageLabel("ARC_GROUP_TECH")).toBe("Group ARC · Technical Approval");
    expect(stageLabel("ARC_GROUP")).toBe("Group ARC · Publish Approval");
    expect(stageLabel("RFQ", { isGroup: true })).toBe("RFQ Approval");
  });

  it("never leaks an underscore", () => {
    for (const t of [...Object.keys(STAGE_LABELS), "ARC_GROUP_COMMITTEE", "NOPE_UNKNOWN"]) {
      expect(stageLabel(t)).not.toMatch(/_/);
      expect(stageLabel(t, { isGroup: true })).not.toMatch(/_/);
      expect(entityLabel(t)).not.toMatch(/_/);
    }
    expect(Object.values(ENTITY_LABELS).join(" ")).not.toMatch(/_/);
  });
});

describe("entityLabel is the notification noun", () => {
  it.each([
    ["NEGOTIATION", "Negotiation round"],
    ["NEGOTIATION_QUOTE", "Final vendor selection"],
    ["TECHNICAL", "Technical evaluation"],
    ["PO", "Purchase order"],
    ["ARC_TECH", "Unit ARC technical evaluation"],
    ["ARC_COMMITTEE", "Unit ARC committee decision"],
    ["ARC_NEGOTIATION", "Unit ARC negotiation round"],
    ["ARC_AMENDMENT", "Unit ARC amendment"],
    ["ARC_PUBLISH", "Unit ARC"],
  ])("%s → %s", (type, noun) => {
    expect(entityLabel(type)).toBe(noun);
  });

  it("says Group ARC for group policies", () => {
    expect(entityLabel("ARC_TECH", { isGroup: true })).toBe("Group ARC technical evaluation");
    expect(entityLabel("ARC_GROUP_COMMITTEE")).toBe("Group ARC committee decision");
  });
});

describe("approval step notification copy", () => {
  const args = (entityType, extraContext = {}) => ({
    entityType,
    entityId: 12,
    entityIdentifier: "12",
    stepOrder: 1,
    totalSteps: 1,
    initiatorName: "Kushal Shah",
    approvers: [{ user_id: 42, user_name: "Asha Menon", user_email: "asha@example.com" }],
    extraContext: { arc_id: 12, rfq_id: 99, ...extraContext },
  });

  it("names the noun from the copy table in subject and in-app title", async () => {
    await sendApprovalStepNotification(args("NEGOTIATION_QUOTE", { rfq_id: 99 }));
    expect(sentMails[0].subject).toContain("Final vendor selection");
    expect(dispatched[0].title).toContain("Final vendor selection");
  });

  it("says Group ARC when the instance belongs to a group policy", async () => {
    await sendApprovalStepNotification(args("ARC_TECH", { is_group: true }));
    expect(dispatched[0].title).toContain("Group ARC technical evaluation");
    expect(dispatched[0].title).not.toContain("Unit ARC");
  });
});

describe("refusal text uses the stage label, data keeps the raw enum", () => {
  it("'nobody can approve' says Final Vendor Approval, not NEGOTIATION_QUOTE", async () => {
    await withTx(async (t) => {
      // Policy whose only step names a role that cannot approve negotiation quotes.
      const policy = await t.one(
        `INSERT INTO tbl_approval_policies
           (entity_type, hospitality_company_id, hotel_id, department_id, process_id,
            is_active, created_by, is_master)
         VALUES ('NEGOTIATION_QUOTE', $1, $2, NULL, NULL, true, $3, true)
         RETURNING id`,
        [IDS.hospitality.A, IDS.hotels.A1, IDS.users.companyA_admin]
      );
      await t.none(
        `INSERT INTO tbl_approval_policy_steps
           (approval_policy_id, step_order, approval_type, decision_rule,
            approver_source_type, approver_source_id)
         VALUES ($1, 1, 'STANDARD', 'ANY', 'ROLE', 2)`,
        [policy.id]
      );
      const err = await createApprovalInstance({
        entity_type: "NEGOTIATION_QUOTE",
        entity_id: 9_500_001,
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        department_id: IDS.departments.hk,
        initiated_by: IDS.users.companyA_admin,
        txContext: t,
      }).catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("Final Vendor Approval");
      expect(err.message).not.toContain("NEGOTIATION_QUOTE");
    });
  });
});
