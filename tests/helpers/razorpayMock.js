// Razorpay client mock for Wave 2 subscription tests + any future test that
// exercises a payment endpoint.
//
// SHAPE OF THE REAL CLIENT (as used in the codebase):
//   import Razorpay from 'razorpay';
//   const razorpay = new Razorpay({ key_id, key_secret });
//   const order = await razorpay.orders.create({ amount, currency, receipt, notes });
//   // returns: { id, amount, currency, receipt, status: 'created', ... }
//
// The codebase verifies signatures itself via crypto.createHmac (sha256 over
// `${order_id}|${payment_id}` keyed by RAZORPAY_SECRET). Tests can therefore
// produce a valid signature deterministically using the same primitives.
//
// USAGE (per-file, top-level):
//
//   import { makeRazorpayMock, signPayment } from "../helpers/razorpayMock.js";
//   const razorpay = makeRazorpayMock();
//   jest.unstable_mockModule("razorpay", razorpay.factory);
//
// Then inside a test:
//   // Trigger the create-order endpoint, capture what was sent:
//   expect(razorpay.captured.orders_create.length).toBe(1);
//   expect(razorpay.captured.orders_create[0].amount).toBe(5000_00);
//
//   // Simulate the post-payment verify call by signing the order id:
//   const order_id = razorpay.captured.orders_create[0].__returned.id;
//   const payment_id = "pay_test_001";
//   const signature = signPayment(order_id, payment_id, "test_secret");
//   // ... post to /verify-payment with { razorpay_order_id, razorpay_payment_id, razorpay_signature }

import crypto from "node:crypto";
import { jest } from "@jest/globals";

/**
 * Build a Razorpay client mock. Each call returns its OWN captured store and
 * factory — use one mock per test file to keep call lists isolated.
 *
 * The factory is suitable as the second argument to
 * `jest.unstable_mockModule("razorpay", factory)`.
 */
export function makeRazorpayMock(opts = {}) {
  const {
    orderIdPrefix = "order_test",
    paymentIdPrefix = "pay_test",
    overrideOrderResponse = null, // (input, baseResponse) => customized response
  } = opts;

  const captured = {
    instances: [],
    orders_create: [],
    payments_fetch: [],
    payments_capture: [],
  };

  let counter = 0;

  const factory = () => {
    const MockRazorpay = jest.fn(function MockRazorpayCtor(config) {
      captured.instances.push(config);

      this.orders = {
        create: async (options) => {
          counter += 1;
          const orderId = `${orderIdPrefix}_${counter.toString().padStart(4, "0")}`;
          const baseResponse = {
            id: orderId,
            entity: "order",
            amount: options?.amount,
            amount_paid: 0,
            amount_due: options?.amount,
            currency: options?.currency || "INR",
            receipt: options?.receipt || null,
            status: "created",
            attempts: 0,
            notes: options?.notes || {},
            created_at: Math.floor(Date.now() / 1000),
          };
          const response = typeof overrideOrderResponse === "function"
            ? overrideOrderResponse(options, baseResponse)
            : baseResponse;
          captured.orders_create.push({ ...options, __returned: response });
          return response;
        },
      };

      this.payments = {
        fetch: async (paymentId) => {
          captured.payments_fetch.push(paymentId);
          return {
            id: paymentId,
            entity: "payment",
            amount: 0,
            currency: "INR",
            status: "captured",
            method: "card",
          };
        },
        capture: async (paymentId, amount, currency = "INR") => {
          captured.payments_capture.push({ paymentId, amount, currency });
          return {
            id: paymentId,
            entity: "payment",
            amount,
            currency,
            status: "captured",
          };
        },
      };
    });

    // Razorpay is imported as `import Razorpay from 'razorpay'` so the mock
    // must expose it as the default export.
    return { default: MockRazorpay };
  };

  return { captured, factory };
}

/**
 * Reproduce the production signature used by hospitalityController's
 * verify-payment branch:
 *   HMAC-SHA256(`${order_id}|${payment_id}`, RAZORPAY_SECRET) → hex
 *
 * Tests should call this with the SAME secret value the controller reads
 * from process.env.RAZORPAY_SECRET (typically set in .env.test to a fixed
 * sentinel like "test_secret").
 */
export function signPayment(orderId, paymentId, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
}

/**
 * Build a complete verify-payment body that the controller will accept.
 * Convenience for tests that don't want to compute the signature inline.
 */
export function buildVerifyPaymentBody({ orderId, paymentId, secret, extra = {} }) {
  return {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signPayment(orderId, paymentId, secret),
    ...extra,
  };
}
