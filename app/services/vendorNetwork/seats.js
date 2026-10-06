// Network seats (spec §5.1). Every non-principal entity needs an active seat to
// operate. At NETWORK_SEAT_FEE_INR = 0 seats are free and activate at once; above 0
// a seat is created `pending` and the org admin pays for it through the same
// Razorpay order/verify pattern the hospitality subscription uses.

import crypto from "crypto";
import db from "../../config/dbConn.js";
import Config from "../../config/app.config.js";
import { seatFeeInr, SEAT_STATUS, istDate } from "../../constants/vendorNetwork.js";
import { logger } from "../../util/logger.js";
import {
  getOrgById,
  getLiveSeat,
  cancelSeatsFromOtherOrgs,
  insertSeat,
  lockPayableSeats,
  listSeatIdsInOpenPayment,
  createSeatPayment,
  getSeatPaymentByOrderId,
  markSeatPaymentPaid,
  activatePendingSeats,
} from "../../models/vendorNetworkModel.js";
import { NetworkHttpError } from "./guards.js";

const IST_OFFSET_MS = 330 * 60 * 1000;
// A 'created' seat payment younger than this is a checkout still in progress.
export const SEAT_ORDER_OPEN_MINUTES = 30;

export { istDate };

/** 'YYYY-03-31' closing the Indian financial year (1 Apr - 31 Mar) that contains `date`. */
export function financialYearEnd(date = new Date()) {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() + 1 : ist.getUTCFullYear();
  return `${year}-03-31`;
}

/**
 * Makes sure the entity has a seat in `orgId` for the current financial year.
 * A pending/active seat of the SAME org is reused (no new row, no new charge); one
 * held from a different org is cancelled in the same transaction before inserting.
 * Fee 0: an active seat (an existing pending one is activated free).
 * Fee > 0: a pending seat to pay for, unless a pending or active one exists.
 * @returns {{ seat, payable: boolean, amount?: number }}
 */
// actorUserId is part of the shared signature; seats carry no actor column yet.
export async function ensureSeatForEntity({ orgId, entityVendorId, actorUserId = null }, runner = db) {
  const fee = seatFeeInr();
  const today = istDate();
  const existing = await getLiveSeat(orgId, entityVendorId, runner, today);
  const endDate = financialYearEnd();

  if (fee <= 0) {
    if (existing?.status === SEAT_STATUS.active) return { seat: existing, payable: false };
    if (existing) {
      const [seat] = await activatePendingSeats(
        { orgId, seatIds: [existing.id], paymentId: null, startDate: today, endDate },
        runner
      );
      return { seat, payable: false };
    }
  } else if (existing) {
    const payable = existing.status === SEAT_STATUS.pending;
    return payable
      ? { seat: existing, payable, amount: Number(existing.fee_amount) }
      : { seat: existing, payable };
  }

  // A seat still held from a previous org is forfeited (no refund) when joining this one.
  await cancelSeatsFromOtherOrgs(orgId, entityVendorId, runner);
  const seat = await insertSeat(
    {
      orgId,
      vendorId: entityVendorId,
      feeAmount: Math.max(fee, 0),
      startDate: today,
      endDate,
      status: fee <= 0 ? SEAT_STATUS.active : SEAT_STATUS.pending,
    },
    runner
  );
  // Only reachable through a concurrent insert for the same entity.
  if (!seat) throw new NetworkHttpError(409, "This entity's seat changed concurrently; retry", "SEAT_CONFLICT");
  return fee <= 0 ? { seat, payable: false } : { seat, payable: true, amount: fee };
}

/**
 * Creates one Razorpay order for the org's pending seats `seatIds` and records it as a
 * `network_seat` payment of the org's principal. Every id must be a pending seat of a
 * live entity of `orgId`, else 404 (the ids are targets, never scope). The seats are
 * locked for the duration, and a seat already in an open checkout (a 'created' payment
 * younger than SEAT_ORDER_OPEN_MINUTES) is refused with 409 PAYMENT_IN_PROGRESS.
 */
export async function createSeatPaymentOrder({ orgId, seatIds, actorUserId }) {
  const ids = [...new Set(seatIds)];
  return db.tx(async (t) => {
    const seats = await lockPayableSeats(orgId, ids, t);
    if (seats.length !== ids.length) throw new NetworkHttpError(404, "Seat not found or not awaiting payment");
    const busy = await listSeatIdsInOpenPayment(orgId, ids, SEAT_ORDER_OPEN_MINUTES, t);
    if (busy.length) {
      throw new NetworkHttpError(409, "A payment for these seats is already in progress", "PAYMENT_IN_PROGRESS");
    }
    const amountPaise = Math.round(seats.reduce((sum, s) => sum + Number(s.fee_amount), 0) * 100);
    if (amountPaise <= 0) throw new NetworkHttpError(409, "Nothing to pay for these seats");

    const org = await getOrgById(orgId, t);
    const { default: Razorpay } = await import("razorpay");
    const razorpay = new Razorpay({
      key_id: Config.razorpay.razorpay_key,
      key_secret: Config.razorpay.razorpay_secret,
    });
    const receipt = `NETSEAT-${orgId}-${Date.now()}`;
    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt,
      payment_capture: 1,
    });

    const payment = await createSeatPayment(
      {
        vendorId: org.principal_vendor_id,
        orderId: order.id,
        amountPaise,
        receipt,
        beforeResponse: JSON.stringify(order),
        metadata: { type: "network_seat", org_id: orgId, seat_ids: ids, actor_user_id: actorUserId },
      },
      t
    );
    return { order, payment_id: payment.id, amount: amountPaise / 100, razorpay_key: Config.razorpay.razorpay_key };
  });
}

/**
 * On a verified payment: the payment becomes 'paid' and the seats it paid for that are
 * still pending become 'active'. A seat no longer pending (e.g. cancelled when its entity
 * was removed after checkout) is skipped and logged; the payment is still recorded paid.
 * @returns {Promise<{ seats: object[], activated: number }>}
 */
export async function activateSeatsForPayment(paymentId, runner = db) {
  const payment = await runner.one(`SELECT * FROM tbl_vendor_payments WHERE id = $1`, [paymentId]);
  const meta = typeof payment.metadata === "string" ? JSON.parse(payment.metadata) : payment.metadata ?? {};
  const seatIds = meta.seat_ids ?? [];
  await markSeatPaymentPaid(paymentId, {}, runner);
  const seats = await activatePendingSeats(
    { orgId: meta.org_id, seatIds, paymentId, startDate: istDate(), endDate: financialYearEnd() },
    runner
  );
  if (seats.length !== seatIds.length) {
    const activatedIds = seats.map((s) => s.id);
    logger.warn(
      { paymentId, orgId: meta.org_id, skippedSeatIds: seatIds.filter((id) => !activatedIds.includes(id)) },
      "vendor-network seat payment covered seats that were no longer pending"
    );
  }
  return { seats, activated: seats.length };
}

/** Razorpay's checkout signature: HMAC-SHA256(order_id|payment_id) with the key secret. */
export function isValidRazorpaySignature(orderId, paymentId, signature) {
  const expected = crypto
    .createHmac("sha256", Config.razorpay.razorpay_secret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  const given = Buffer.from(String(signature));
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

/**
 * Verifies a seat payment of `orgId` and activates its seats. A payment of another org
 * is 404 even with a valid signature. Re-verifying a paid payment is a no-op.
 */
export async function verifySeatPayment({ orgId, razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  if (!isValidRazorpaySignature(razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
    throw new NetworkHttpError(400, "Payment verification failed - invalid signature");
  }
  return db.tx(async (t) => {
    const payment = await getSeatPaymentByOrderId(razorpayOrderId, t, { forUpdate: true });
    const meta = typeof payment?.metadata === "string" ? JSON.parse(payment.metadata) : payment?.metadata;
    if (!payment || Number(meta?.org_id) !== Number(orgId)) {
      throw new NetworkHttpError(404, "Payment record not found");
    }
    if (payment.payment_status === "paid") {
      return { payment_id: payment.id, already_paid: true, seats: [], activated: 0 };
    }
    await markSeatPaymentPaid(payment.id, { razorpayPaymentId, razorpaySignature }, t);
    const { seats, activated } = await activateSeatsForPayment(payment.id, t);
    return { payment_id: payment.id, already_paid: false, seats, activated };
  });
}

export default {
  istDate,
  financialYearEnd,
  ensureSeatForEntity,
  createSeatPaymentOrder,
  activateSeatsForPayment,
  isValidRazorpaySignature,
  verifySeatPayment,
};
