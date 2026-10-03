// PDF / PERF — POST /api/v1/hospitality/verify-payment answers before the
// confirmation email, and the email now carries its invoice + receipt.
// ----------------------------------------------------------------------------
// Prod: p95 30 s, handler ~66 s, because the handler awaited
// _sendSubscriptionConfirmationEmail (two Chromium launches with
// `networkidle0`, both timing out, then SMTP) before responding. And because
// both renders timed out, every confirmation email went out WITHOUT the
// invoice and receipt it promises.
//
// Here, over real HTTP with a genuine Razorpay HMAC signature and a real
// Chromium (this suite runs in the Chromium shard), with only the SMTP
// transport replaced by one whose send we hold open:
//   1. the response arrives while the email is still blocked in SMTP
//   2. the email is then sent with BOTH PDFs attached, and they are real PDFs
//   3. the payment row is marked success regardless

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import crypto from "crypto";
import fs from "fs";
import nodemailer from "nodemailer";
import request from "supertest";
import Config from "../../app/config/app.config.js";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { buildTestApp } from "../setup/app.js";
import { pdfRenderer, createPdfRenderer } from "../../app/util/pdfRenderer.js";

const VENDOR = IDS.users.vendor_alpha;
const ORDER_ID = `order_beplat_${Date.now()}`;
const PAYMENT_ID = `pay_beplat_${Date.now()}`;

let realRenderer;
let stubRenderToFile;
let stubCreateTransport;
let paymentRowId;
let maxNotificationId;
let vendorStatusBefore;

// SMTP boundary: records every message and holds the send open until released.
const smtp = { sent: [], release: null, released: null };
smtp.released = new Promise((r) => (smtp.release = r));

const waitFor = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await predicate();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

beforeAll(async () => {
  realRenderer = createPdfRenderer({ maxConcurrent: 1 });
  stubRenderToFile = pdfRenderer.renderToFile;
  pdfRenderer.renderToFile = (...a) => realRenderer.renderToFile(...a);

  stubCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail(mailOptions, cb) {
      smtp.sent.push(mailOptions);
      const done = () => {
        const info = { messageId: "<held-smtp>", response: "250 OK" };
        if (typeof cb === "function") cb(null, info);
        return info;
      };
      return smtp.released.then(done);
    },
    verify: () => Promise.resolve(true),
    close() {},
  });

  ({ status: vendorStatusBefore } = await db.one(`SELECT status FROM tbl_users WHERE id = $1`, [VENDOR]));
  ({ max: maxNotificationId } = await db.one(`SELECT COALESCE(MAX(id), 0) AS max FROM tbl_notifications`));
  const row = await db.one(
    `INSERT INTO tbl_vendor_payments
       (vendor_id, razorpay_order_id, amount, currency, payment_status, payment_type, receipt, metadata)
     VALUES ($1, $2, 11800, 'INR', 'created', 'hospitality', $3, $4::jsonb)
     RETURNING id`,
    [VENDOR, ORDER_ID, `REG-${ORDER_ID}`, JSON.stringify({ subscription_items: [] })]
  );
  paymentRowId = row.id;
});

afterAll(async () => {
  smtp.release();
  pdfRenderer.renderToFile = stubRenderToFile;
  nodemailer.createTransport = stubCreateTransport;
  await realRenderer.close();
  for (const mail of smtp.sent) {
    for (const a of mail.attachments || []) {
      try {
        fs.unlinkSync(a.path);
      } catch {}
    }
  }
  await db.none(
    `DELETE FROM tbl_notifications WHERE id > $1 AND recipient_user_id = $2`,
    [maxNotificationId, VENDOR]
  );
  if (paymentRowId) await db.none(`DELETE FROM tbl_vendor_payments WHERE id = $1`, [paymentRowId]);
  await db.none(`UPDATE tbl_users SET status = $2 WHERE id = $1`, [VENDOR, vendorStatusBefore]);
  await closeDb();
});

describe("POST /api/v1/hospitality/verify-payment", () => {
  it("responds before the confirmation email, then emails both PDFs attached", async () => {
    const app = await buildTestApp();
    const signature = crypto
      .createHmac("sha256", Config.razorpay.razorpay_secret)
      .update(`${ORDER_ID}|${PAYMENT_ID}`)
      .digest("hex");

    // SMTP is held open for the whole request. Before the fix the handler
    // awaited the email, so this request could never complete.
    const started = Date.now();
    const res = await Promise.race([
      request(app).post("/api/v1/hospitality/verify-payment").send({
        razorpay_order_id: ORDER_ID,
        razorpay_payment_id: PAYMENT_ID,
        razorpay_signature: signature,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("verify-payment waited on the email")), 15_000)
      ),
    ]);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.payment_id).toBe(PAYMENT_ID);
    // Nothing has been released from SMTP yet: the response did not wait.
    expect(elapsed).toBeLessThan(15_000);

    const payment = await db.one(`SELECT payment_status, razorpay_payment_id FROM tbl_vendor_payments WHERE id = $1`, [
      paymentRowId,
    ]);
    expect(payment).toEqual({ payment_status: "success", razorpay_payment_id: PAYMENT_ID });

    // The background job renders both PDFs and hands the email to SMTP.
    const mail = await waitFor(
      () => smtp.sent.find((m) => /Vendor Registration Confirmation|Subscription Renewal/.test(m.subject)),
      30_000,
      "confirmation email"
    );
    const attachments = mail.attachments || [];
    expect(attachments.map((a) => a.filename).sort()).toEqual([
      expect.stringMatching(/^payment-received-/),
      expect.stringMatching(/^tax-invoice-/),
    ]);
    for (const a of attachments) {
      expect(a.contentType).toBe("application/pdf");
      const bytes = fs.readFileSync(a.path);
      expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
      expect(bytes.length).toBeGreaterThan(1000); // a real render, not the stub
    }

    // Let SMTP finish; the job then records the in-app notification.
    smtp.release();
    await waitFor(
      () =>
        db.oneOrNone(
          `SELECT id FROM tbl_notifications
            WHERE id > $1 AND recipient_user_id = $2 AND type LIKE 'subscription_%'`,
          [maxNotificationId, VENDOR]
        ),
      10_000,
      "subscription notification"
    );
  });
});
