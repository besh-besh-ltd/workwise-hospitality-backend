// Naming the RFQ in the mail that asks a vendor to accept a purchase order.
//
// The acceptance-request mail and its three reminders told the vendor the PO
// number and the RFQ *number*, but never the RFQ *title*. A vendor quoting on
// several RFQs for the same buyer had nothing to identify which tender the
// order settled. The buyer-facing mails in this very file already print both
// (see the "RFQ:" line of sendPOApprovalRequestToBuyer) — so this was a plain
// inconsistency, not a missing join: `rfqDetails.title` is already selected at
// both call sites (purchaseOrderController and generalModel.markPOStatusChange).
//
// Production carries 28 POs in `acceptance_pending`, so this is live traffic.
// Client feedback item 13.
//
// Per CONVENTIONS.md §1 the production email builders are driven directly; the
// only mocks are the mail transport (so the HTML can be read), the vendor
// lookup and the product query (so no DB is needed), and the in-app dispatch.

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
  resolveRecipientUserIds: async (rs = []) => rs.map((r) => r.user_id || r.id).filter(Boolean),
}));

// One product line on the PO — enough for the template, and it keeps the
// assertions about the RFQ line unambiguous.
jest.unstable_mockModule("../../app/config/dbConn.js", () => ({
  default: {
    any: async () => [
      { id: 1, name: "5 WATT LED PANEL LIGHT", quantity: 10, unit: "nos", unit_price: 120, total_price: 1200 },
    ],
    one: async () => ({}),
    oneOrNone: async () => null,
    none: async () => {},
    tx: async (fn) => fn({ any: async () => [], none: async () => {} }),
  },
  pgp: {},
}));

jest.unstable_mockModule("../../app/models/userModel.js", () => ({
  default: {
    getUserById: async () => [
      { id: 501, name: "Surya Enterprises", organization_name: "Surya Enterprises", email: "surya.entp1987@example.com" },
    ],
  },
}));

const {
  sendPOAcceptanceRequestToVendor,
  sendPOAcceptanceReminderToVendor,
} = await import("../../app/controllers/po/purchaseOrderEmails.js");

// Shape of stage RFQ 2386 / PO 138859.
const RFQ_NO = 536631;
const RFQ_TITLE = "ORCHID PASSAROS GOA - 5 WATT LED PANEL LIGHT";

const PO = {
  id: 587,
  po_number: "138859",
  rfq_id: 2386,
  finalized_vendor_id: 501,
  status: "acceptance_pending",
};

const lastMail = () => sentMails[sentMails.length - 1];

beforeEach(() => {
  sentMails.length = 0;
  dispatched.length = 0;
});

describe("the mail asking a vendor to accept a PO", () => {
  it("names the RFQ number and title in the body", async () => {
    await sendPOAcceptanceRequestToVendor(PO, { rfq_no: RFQ_NO, title: RFQ_TITLE });

    expect(lastMail().html).toContain(String(RFQ_NO));
    expect(lastMail().html).toContain(RFQ_TITLE);
  });

  it("names the RFQ number and title in the subject, so it is legible in an inbox list", async () => {
    await sendPOAcceptanceRequestToVendor(PO, { rfq_no: RFQ_NO, title: RFQ_TITLE });

    expect(lastMail().subject).toContain(`PO #${PO.po_number}`);
    expect(lastMail().subject).toContain(String(RFQ_NO));
    expect(lastMail().subject).toContain(RFQ_TITLE);
  });

  it("names the RFQ in the push notification too", async () => {
    await sendPOAcceptanceRequestToVendor(PO, { rfq_no: RFQ_NO, title: RFQ_TITLE });

    const note = dispatched.find((d) => d.type === "po_acceptance_request");
    expect(note).toBeTruthy();
    expect(`${note.title} ${note.body}`).toContain(String(RFQ_NO));
  });

  it("leaves no dangling dash when the title is blank, which is the common case", async () => {
    // tbl_rfq.title is nullable and empty in practice.
    await sendPOAcceptanceRequestToVendor(PO, { rfq_no: RFQ_NO, title: "" });

    expect(lastMail().subject).toContain(String(RFQ_NO));
    expect(lastMail().subject).not.toMatch(/—\s*—/);
    expect(lastMail().subject).not.toMatch(/#\d+\s+—\s*$/);
    expect(lastMail().html).not.toMatch(/undefined|null/);
  });

  it("survives rfqDetails being absent altogether", async () => {
    await expect(sendPOAcceptanceRequestToVendor(PO, null)).resolves.not.toThrow();
    expect(lastMail().html).not.toMatch(/undefined|null/);
  });
});

describe("the tiered acceptance reminders", () => {
  // The cron previously selected only r.rfq_no and passed only { rfq_no },
  // so the title could not reach this template even once it was added.
  for (const n of [1, 2, 3]) {
    it(`names the RFQ number and title in reminder #${n}`, async () => {
      await sendPOAcceptanceReminderToVendor(PO, { rfq_no: RFQ_NO, title: RFQ_TITLE }, n);

      expect(lastMail().html).toContain(String(RFQ_NO));
      expect(lastMail().html).toContain(RFQ_TITLE);
    });
  }

  it("leaves no dangling dash on a blank title", async () => {
    await sendPOAcceptanceReminderToVendor(PO, { rfq_no: RFQ_NO, title: null }, 1);

    expect(lastMail().html).toContain(String(RFQ_NO));
    expect(lastMail().html).not.toMatch(/undefined|null/);
    expect(lastMail().html).not.toMatch(/#\d+\s*—\s*</);
  });
});
