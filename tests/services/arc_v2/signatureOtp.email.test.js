// signatureOtp.email — the vendor's signing code reaches them by email (REQ-2026-0092).
//
// Before: POST .../otp/request created the code and only returned it outside
// production (dev_code). In production the vendor was told "sent to your
// registered phone & email" and got nothing, so no rate contract or addendum
// could be signed. These tests go over HTTP and capture what nodemailer sends.

import nodemailer from "nodemailer";
import arcContractModel from "../../../app/models/arc_v2/arcContractModel.js";
import { db } from "../../setup/db.js";
import { httpClient } from "../../helpers/http.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const BASE = "/api/v1/arc-v2/vendor";
const VENDOR = IDS.users.vendor_alpha;
const OTHER_VENDOR = IDS.users.vendor_beta;
const BUYER = IDS.users.a1_proc_buyer;

// Captured mail; `failMail` makes the transport refuse, as an SMTP outage would.
const sent = [];
let failMail = false;
let realCreateTransport;
const otpMails = () => sent.filter((m) => /^Your code to sign/.test(m.subject || ""));
const codeIn = (mail) => (String(mail.html).match(/letter-spacing: 8px[^>]*>(\d{6})</) || [])[1];

describe("signing code is emailed to the vendor", () => {
  let arcId, contractId, amendmentId, addendumId, vendorEmail, vendor, other;

  beforeAll(async () => {
    realCreateTransport = nodemailer.createTransport;
    nodemailer.createTransport = () => ({
      sendMail(opts, cb) {
        if (failMail) return cb(new Error("SMTP unavailable"));
        sent.push(opts);
        return cb(null, { messageId: "<captured>", response: "250 OK" });
      },
    });

    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = ANY($1::int[])`, [[VENDOR, OTHER_VENDOR]]);
    vendorEmail = (await db.one(`SELECT email FROM tbl_users WHERE id = $1`, [VENDOR])).email;
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-TEST-OTP-MAIL', 'Charcoal supply', $1, $2, $3, $4, $5, 'awaiting_vendor_acceptance',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day', NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days', $6)
       RETURNING id`,
      [TEST_CATEGORIES.beverages, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, IDS.processes.A_P1, BUYER]
    );
    arcId = arc.id;
    contractId = (await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status, awaiting_until)
       VALUES ($1, $2, 'awaiting_acceptance', NOW() + INTERVAL '3 days') RETURNING id`,
      [arcId, VENDOR]
    )).id;
    amendmentId = (await db.one(
      `INSERT INTO tbl_arc_amendment (arc_contract_id, amendment_type, amendment_from, status, reason, requested_by)
       VALUES ($1, 'term', CURRENT_DATE, 'awaiting_signature', 'payment terms change', $2) RETURNING id`,
      [contractId, VENDOR]
    )).id;
    addendumId = (await db.one(
      `INSERT INTO tbl_arc_amendment_document (arc_amendment_id, arc_contract_id, addendum_number, status)
       VALUES ($1, $2, 1, 'awaiting_signature') RETURNING id`,
      [amendmentId, contractId]
    )).id;
    vendor = await httpClient(VENDOR);
    other = await httpClient(OTHER_VENDOR);
  });

  afterAll(async () => {
    nodemailer.createTransport = realCreateTransport;
    await db.none(`DELETE FROM tbl_arc_contract_signature_otp WHERE arc_contract_id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_amendment_document WHERE id = $1`, [addendumId]);
    await db.none(`DELETE FROM tbl_arc_amendment WHERE id = $1`, [amendmentId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = $1`, [String(arcId)]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
  });

  beforeEach(async () => {
    sent.length = 0;
    failMail = false;
    await db.none(`DELETE FROM tbl_arc_contract_signature_otp WHERE arc_contract_id = $1`, [contractId]);
  });

  const otpRows = () => db.one(`SELECT count(*)::int AS n FROM tbl_arc_contract_signature_otp WHERE arc_contract_id = $1`, [contractId]).then((r) => r.n);

  it("emails the code to the vendor's registered address; the emailed code is the one that signs", async () => {
    const res = await vendor.post(`${BASE}/contracts/${contractId}/otp/request`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.sent_to).toEqual([expect.stringMatching(/^al\*+@vendor\.test$/)]);
    expect(res.body.data.resend_after_seconds).toBe(60);

    const mails = otpMails();
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(vendorEmail);
    expect(mails[0].subject).toBe("Your code to sign rate contract ARC-TEST-OTP-MAIL");
    expect(mails[0].html).toContain("Charcoal supply");
    const code = codeIn(mails[0]);
    expect(code).toMatch(/^\d{6}$/);
    expect(code).toBe(res.body.data.dev_code);
    expect((await arcContractModel.verifyOtp(contractId, VENDOR, code)).ok).toBe(true);
  });

  it("asking again within a minute is refused with the wait, and sends no second email or code", async () => {
    expect((await vendor.post(`${BASE}/contracts/${contractId}/otp/request`).send({})).status).toBe(200);
    const again = await vendor.post(`${BASE}/contracts/${contractId}/otp/request`).send({});
    expect(again.status).toBe(429);
    expect(again.body.data.retry_after_seconds).toBeGreaterThan(0);
    expect(again.body.data.retry_after_seconds).toBeLessThanOrEqual(60);
    expect(otpMails()).toHaveLength(1);
    expect(await otpRows()).toBe(1);
  });

  it("after the minute a new code is emailed and replaces the old one", async () => {
    const first = await vendor.post(`${BASE}/contracts/${contractId}/otp/request`).send({});
    await db.none(`UPDATE tbl_arc_contract_signature_otp SET created_at = created_at - INTERVAL '61 seconds' WHERE arc_contract_id = $1`, [contractId]);
    const second = await vendor.post(`${BASE}/contracts/${contractId}/otp/request`).send({});
    expect(second.status).toBe(200);
    expect(otpMails()).toHaveLength(2);
    const newCode = codeIn(otpMails()[1]);
    expect(newCode).toBe(second.body.data.dev_code);
    if (newCode !== first.body.data.dev_code) {
      expect((await arcContractModel.verifyOtp(contractId, VENDOR, first.body.data.dev_code)).ok).toBe(false);
    }
    expect((await arcContractModel.verifyOtp(contractId, VENDOR, newCode)).ok).toBe(true);
  });

  it("if the email can't be sent: 502, no code is left behind, and the vendor can retry straight away", async () => {
    failMail = true;
    const res = await vendor.post(`${BASE}/contracts/${contractId}/otp/request`).send({});
    expect(res.status).toBe(502);
    expect(res.body.message).toMatch(/couldn't email the signing code/);
    expect(await otpRows()).toBe(0);

    failMail = false;
    const retry = await vendor.post(`${BASE}/contracts/${contractId}/otp/request`).send({});
    expect(retry.status).toBe(200);
    expect(otpMails()).toHaveLength(1);
  });

  it("a vendor with no email address is told so; no code is created", async () => {
    await db.none(`UPDATE tbl_users SET email = '' WHERE id = $1`, [VENDOR]);
    try {
      const res = await vendor.post(`${BASE}/contracts/${contractId}/otp/request`).send({});
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/no email address/);
      expect(await otpRows()).toBe(0);
      expect(otpMails()).toHaveLength(0);
    } finally {
      await db.none(`UPDATE tbl_users SET email = $2 WHERE id = $1`, [VENDOR, vendorEmail]);
    }
  });

  it("in production the code is in the email only, never in the response", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    let res;
    try {
      res = await vendor.post(`${BASE}/contracts/${contractId}/otp/request`).send({});
    } finally {
      process.env.NODE_ENV = prev;
    }
    expect(res.status).toBe(200);
    expect(res.body.data.dev_code).toBeUndefined();
    expect(res.body.data.sent_to).toHaveLength(1);
    expect(codeIn(otpMails()[0])).toMatch(/^\d{6}$/);
  });

  it("another vendor can't request the code, and nothing is emailed", async () => {
    const res = await other.post(`${BASE}/contracts/${contractId}/otp/request`).send({});
    expect(res.status).toBe(403);
    expect(otpMails()).toHaveLength(0);
    expect(await otpRows()).toBe(0);
  });

  it("an addendum's signing code is emailed too, with its own one-minute wait", async () => {
    const res = await vendor.post(`${BASE}/addendums/${addendumId}/otp/request`).send({});
    expect(res.status).toBe(200);
    const mails = otpMails();
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(vendorEmail);
    expect(mails[0].subject).toBe("Your code to sign addendum to rate contract ARC-TEST-OTP-MAIL");
    expect(codeIn(mails[0])).toBe(res.body.data.dev_code);

    const again = await vendor.post(`${BASE}/addendums/${addendumId}/otp/request`).send({});
    expect(again.status).toBe(429);
    // The addendum's wait doesn't block the contract's own code.
    expect((await vendor.post(`${BASE}/contracts/${contractId}/otp/request`).send({})).status).toBe(200);
  });
});
