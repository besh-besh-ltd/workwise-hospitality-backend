// Approval-email deep links for per-product vendor finalization.
//
// The defect this guards: NEGOTIATION_QUOTE approvals are raised PER PRODUCT
// (entity_id = rfq_product_id), but the mail linked per RFQ. Production RFQ
// #536255 (id 711) has 47 pending finalization approvals across 47 products —
// the approver received 47 mails whose "Review & Approve" buttons all pointed
// at the identical URL, then had to find 47 different cards by hand.
//
// Product-level: we drive the real `sendApprovalStepNotification` /
// `sendApprovalCancelledNotification` and assert on the URL that lands in the
// approver's inbox. The only mocks are the mail transport (so we can read the
// HTML) and the in-app notification dispatch (so no DB write is needed) — the
// link-building logic under test is production code, per CONVENTIONS.md §1.

import { describe, it, expect, beforeEach, jest } from "@jest/globals";

// Captured outbound mail — one entry per recipient.
const sentMails = [];
// Captured in-app notifications — they carry the same actionUrl as the mail,
// so a divergence between the two surfaces would show up here.
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

const {
  sendApprovalStepNotification,
  sendApprovalCancelledNotification,
} = await import("../../app/helper/sendEmailFunctions/approvalEmails.js");

// Production shape of RFQ #536255: one RFQ, many products, one approval
// instance per product.
const RFQ_ID = 711;
const RFQ_NO = "536255";
const PRODUCT_A = 8891;
const PRODUCT_B = 8892;

const APPROVER = [
  { user_id: 42, user_name: "Asha Menon", user_email: "asha@example.com" },
];

// Mirrors what generalModel.js actually passes:
//   extraContext: { rfq_id: metadata?.rfq_id || entity_id, ... }
const stepArgs = (entityId, overrides = {}) => ({
  entityType: "NEGOTIATION_QUOTE",
  entityId,
  entityIdentifier: RFQ_NO,
  stepOrder: 1,
  totalSteps: 1,
  initiatorName: "Ravi Kumar",
  approvers: APPROVER,
  extraContext: { rfq_id: RFQ_ID, rfq_title: "Guest room linen", ...overrides },
});

// The single <a href> the approver clicks ("Review & Approve").
const ctaHref = (mail) => {
  const matches = [...String(mail.html).matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  return matches.find((href) => href.includes("/dashboard")) || null;
};

beforeEach(() => {
  sentMails.length = 0;
  dispatched.length = 0;
});

describe("NEGOTIATION_QUOTE approval email — per-product deep link", () => {
  it("carries both the RFQ and the specific product, with the focus hint", async () => {
    await sendApprovalStepNotification(stepArgs(PRODUCT_A));

    expect(sentMails).toHaveLength(1);
    const href = ctaHref(sentMails[0]);

    expect(href).toContain("/dashboard/buyer/quote-compare");
    expect(href).toContain(`rfq=${RFQ_ID}`);
    expect(href).toContain(`rfq_product_id=${PRODUCT_A}`);
    expect(href).toContain("focus=approval");
  });

  it("gives two products on the same RFQ two DIFFERENT links", async () => {
    // The whole point: 47 mails must not all resolve to the same URL.
    await sendApprovalStepNotification(stepArgs(PRODUCT_A));
    await sendApprovalStepNotification(stepArgs(PRODUCT_B));

    const [first, second] = sentMails.map(ctaHref);
    expect(first).not.toBe(second);
    expect(first).toContain(`rfq_product_id=${PRODUCT_A}`);
    expect(second).toContain(`rfq_product_id=${PRODUCT_B}`);
    // ...while still pointing at the same RFQ.
    expect(first).toContain(`rfq=${RFQ_ID}`);
    expect(second).toContain(`rfq=${RFQ_ID}`);
  });

  it("keeps the in-app notification's actionUrl in step with the mail", async () => {
    await sendApprovalStepNotification(stepArgs(PRODUCT_A));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].actionUrl).toBe(ctaHref(sentMails[0]));
  });

  describe("when metadata.rfq_id is missing", () => {
    // generalModel falls back to `rfq_id: metadata?.rfq_id || entity_id`, so a
    // missing metadata.rfq_id surfaces here as rfq_id === the product id.
    // Latent today (all 1,770 live instances carry metadata.rfq_id) — but the
    // failure mode is silent and severe, so it is pinned.
    const orphaned = () => stepArgs(PRODUCT_A, { rfq_id: PRODUCT_A });

    it("refuses to link to a different RFQ", async () => {
      await sendApprovalStepNotification(orphaned());

      const href = ctaHref(sentMails[0]);
      // The bug being prevented: `?rfq=8891` would open whatever RFQ happens to
      // have id 8891 — someone else's contract entirely.
      expect(href).not.toContain(`rfq=${PRODUCT_A}`);
      expect(href).not.toContain("/quote-compare");
    });

    it("still sends the mail, landing the approver somewhere safe", async () => {
      await sendApprovalStepNotification(orphaned());

      expect(sentMails).toHaveLength(1);
      expect(ctaHref(sentMails[0])).toContain("/dashboard");
    });
  });
});

describe("link builder — neighbouring entity types are unaffected", () => {
  it("NEGOTIATION (round) still links at RFQ level, with no product param", async () => {
    await sendApprovalStepNotification({
      ...stepArgs(4321),
      entityType: "NEGOTIATION",
    });

    const href = ctaHref(sentMails[0]);
    expect(href).toContain(`/dashboard/buyer/quote-compare?rfq=${RFQ_ID}`);
    expect(href).not.toContain("rfq_product_id");
  });

  it("cancellation mail links at RFQ level rather than inventing a product", async () => {
    // This caller only knows the RFQ (the instance is already gone) and passes
    // rfq_id as the entity id. Publishing that as `rfq_product_id` would point
    // the reader at an unrelated product.
    await sendApprovalCancelledNotification({
      entityType: "NEGOTIATION_QUOTE",
      entityIdentifier: RFQ_NO,
      reason: "RFQ closed by creator",
      approvers: APPROVER,
      extraContext: { rfq_id: RFQ_ID },
    });

    const href = ctaHref(sentMails[0]);
    expect(href).toContain(`/dashboard/buyer/quote-compare?rfq=${RFQ_ID}`);
    expect(href).not.toContain("rfq_product_id");
  });
});
