// Wave-2 infra smoke tests — verifies the email-capture, time-mock, and
// Razorpay-mock helpers behave as their JSDoc claims.
//
// These are unit-shaped tests (no DB, no jest.unstable_mockModule) — they
// only exercise the helper return shapes so a regression in the helper
// itself is caught before it cascades into the Wave-2 feature tests.

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import {
  captureApprovalEmails,
  capturePurchaseOrderEmails,
  captureAllEmails,
} from "./emailCapture.js";
import { freezeTime, advanceTime, restoreTime, withFrozenTime } from "./time.js";
import { makeRazorpayMock, signPayment, buildVerifyPaymentBody } from "./razorpayMock.js";

describe("emailCapture", () => {
  it("captureApprovalEmails().factory() returns a module-shape with no-op functions per export", () => {
    const ec = captureApprovalEmails();
    const mod = ec.factory();
    expect(typeof mod.sendVendorRfqNotification).toBe("function");
    expect(typeof mod.sendRfqPublishedNotification).toBe("function");
    // Calling a mocked fn pushes its args into the matching captured array.
    return mod.sendVendorRfqNotification({ rfq_id: 999, vendors: [] }).then(() => {
      expect(ec.captured.sendVendorRfqNotification.length).toBe(1);
      expect(ec.captured.sendVendorRfqNotification[0]).toEqual({ rfq_id: 999, vendors: [] });
    });
  });

  it("reset() clears every captured array in place (preserves array identity)", async () => {
    const ec = captureApprovalEmails();
    const mod = ec.factory();
    await mod.sendVendorRfqNotification({ rfq_id: 1 });
    await mod.sendRfqPublishedNotification({ rfq_id: 1 });
    const sameRef = ec.captured.sendVendorRfqNotification;
    ec.reset();
    expect(ec.captured.sendVendorRfqNotification.length).toBe(0);
    expect(ec.captured.sendRfqPublishedNotification.length).toBe(0);
    expect(ec.captured.sendVendorRfqNotification).toBe(sameRef);
  });

  it("capturePurchaseOrderEmails covers the controller-side surface", () => {
    const ec = capturePurchaseOrderEmails();
    const mod = ec.factory();
    expect(typeof mod.sendPONotificationToVendor).toBe("function");
    expect(typeof mod.sendVendorRejectionNotification).toBe("function");
    expect(typeof mod.sendPOAcceptedNotificationToTeam).toBe("function");
  });

  it("captureAllEmails bundles every email module helper", () => {
    const all = captureAllEmails();
    expect(all.approvalEmails).toBeDefined();
    expect(all.poEmails).toBeDefined();
    expect(all.purchaseOrderEmails).toBeDefined();
    expect(all.techEvalEmails).toBeDefined();
    expect(all.negotiationEmails).toBeDefined();
    expect(all.generalReminderEmails).toBeDefined();
    expect(all.milestoneEmails).toBeDefined();
    expect(all.tenderFeeEmails).toBeDefined();
    expect(all.whatsapp).toBeDefined();
    // Each entry has the standard tri-shape.
    for (const key of Object.keys(all)) {
      expect(all[key]).toEqual(
        expect.objectContaining({
          captured: expect.any(Object),
          reset: expect.any(Function),
          factory: expect.any(Function),
        })
      );
    }
  });
});

describe("time-mock helper", () => {
  afterEach(() => restoreTime());

  it("freezeTime pins Date.now() to the supplied instant", () => {
    freezeTime("2026-05-03T10:00:00Z");
    expect(new Date().toISOString()).toBe("2026-05-03T10:00:00.000Z");
  });

  it("advanceTime moves the clock forward and flushes microtasks", async () => {
    freezeTime("2026-05-03T10:00:00Z");
    let fired = false;
    setTimeout(() => { fired = true; }, 5_000);
    await advanceTime(5_000);
    expect(fired).toBe(true);
    expect(new Date().toISOString()).toBe("2026-05-03T10:00:05.000Z");
  });

  it("restoreTime returns the real clock", () => {
    freezeTime("2026-01-01T00:00:00Z");
    restoreTime();
    // Real clock should be sometime well after Jan 2026 — sanity-check we're not still frozen.
    const now = new Date();
    expect(now.getFullYear()).toBeGreaterThanOrEqual(2026);
    expect(now.toISOString()).not.toBe("2026-01-01T00:00:00.000Z");
  });

  it("withFrozenTime auto-restores after fn finishes", async () => {
    const result = await withFrozenTime("2027-07-04T12:00:00Z", async () => {
      return new Date().toISOString();
    });
    expect(result).toBe("2027-07-04T12:00:00.000Z");
    // After the helper, real clock is back.
    const now = new Date();
    expect(now.toISOString()).not.toBe("2027-07-04T12:00:00.000Z");
  });

  it("freezeTime rejects an invalid date", () => {
    expect(() => freezeTime("not-a-date")).toThrow(/invalid date/i);
  });
});

describe("razorpay-mock helper", () => {
  it("factory exposes a default-export class that captures orders.create calls", async () => {
    const rzp = makeRazorpayMock();
    const mod = rzp.factory();
    const Razorpay = mod.default;

    const client = new Razorpay({ key_id: "rzp_test_k", key_secret: "secret" });
    expect(rzp.captured.instances).toEqual([{ key_id: "rzp_test_k", key_secret: "secret" }]);

    const order = await client.orders.create({
      amount: 50_000_00,
      currency: "INR",
      receipt: "rcpt_001",
      notes: { vendor_id: 80101 },
    });

    expect(order.id).toMatch(/^order_test_\d{4}$/);
    expect(order.amount).toBe(50_000_00);
    expect(order.currency).toBe("INR");
    expect(order.receipt).toBe("rcpt_001");
    expect(order.status).toBe("created");

    expect(rzp.captured.orders_create.length).toBe(1);
    expect(rzp.captured.orders_create[0].amount).toBe(50_000_00);
    expect(rzp.captured.orders_create[0].__returned.id).toBe(order.id);
  });

  it("orderIdPrefix override works for tests that want predictable ids", async () => {
    const rzp = makeRazorpayMock({ orderIdPrefix: "order_sub" });
    const Razorpay = rzp.factory().default;
    const client = new Razorpay({ key_id: "k", key_secret: "s" });
    const order = await client.orders.create({ amount: 100 });
    expect(order.id).toMatch(/^order_sub_\d{4}$/);
  });

  it("signPayment + buildVerifyPaymentBody are deterministic and consistent", () => {
    const sig1 = signPayment("order_X", "pay_Y", "test_secret");
    const sig2 = signPayment("order_X", "pay_Y", "test_secret");
    expect(sig1).toBe(sig2);
    expect(sig1).toHaveLength(64); // hex-encoded sha256

    const sigDifferentSecret = signPayment("order_X", "pay_Y", "other_secret");
    expect(sigDifferentSecret).not.toBe(sig1);

    const body = buildVerifyPaymentBody({
      orderId: "order_X",
      paymentId: "pay_Y",
      secret: "test_secret",
      extra: { hotel_id: 10101 },
    });
    expect(body.razorpay_order_id).toBe("order_X");
    expect(body.razorpay_payment_id).toBe("pay_Y");
    expect(body.razorpay_signature).toBe(sig1);
    expect(body.hotel_id).toBe(10101);
  });
});
