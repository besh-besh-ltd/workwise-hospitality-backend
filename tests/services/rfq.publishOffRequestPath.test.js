/**
 * POST /rfq/internal/publish — notifications leave the request path.
 *
 * The scheduler Lambda's publish used to run, INSIDE the publish transaction
 * and before responding: the "published" emails (awaited SMTP, one by one),
 * an in-app row + web-push fan-out per recipient, and one INSERT per vendor
 * into tbl_vendor_rfq_tokens_non_login. Now the publish's DB writes commit in
 * the transaction, the endpoint responds, and the notification work runs
 * afterwards with its tokens written in ONE statement.
 *
 * Proven here:
 *   - the response arrives while the "published" email is still blocked, and
 *     the RFQ is already committed as published at that point;
 *   - the notifications still go out afterwards, every vendor gets exactly one
 *     token, written by a single INSERT;
 *   - a notification failure after the response is caught and logged by the
 *     notification step itself; the response and the publish are unaffected.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";
import crypto from "crypto";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";

const calls = { publish: [], vendor: [] };
let releasePublishEmail = () => {};
let publishEmailGate = Promise.resolve();
let publishEmailShouldThrow = false;

jest.unstable_mockModule("../../app/helper/sendEmailFunctions/approvalEmails.js", () => ({
  sendRfqCreationNotification: async () => {},
  sendApprovalStepNotification: async () => {},
  sendRfqReadyToPublishNotification: async () => {},
  sendRfqPublishedNotification: async (args) => {
    await publishEmailGate;
    if (publishEmailShouldThrow) throw new Error("SMTP exploded");
    calls.publish.push(args);
  },
  sendVendorRfqNotification: async (args) => { calls.vendor.push(args); },
  sendVendorAutoAddedToRfqNotification: async () => {},
  sendVendorBulkRfqJoinNotification: async () => {},
  sendRfqClosedHeadsUpNotification: async () => {},
  sendApprovalCancelledNotification: async () => {},
  sendPolicyChangeNotification: async () => {},
  sendApproverRemovedNotification: async () => {},
  sendApprovalStandsNotification: async () => {},
  sendApproverAddedMidFlightNotification: async () => {},
}));
jest.unstable_mockModule("@aws-sdk/client-scheduler", () => ({
  SchedulerClient: class { send = async () => ({}); },
  CreateScheduleCommand: class {},
  UpdateScheduleCommand: class {},
  DeleteScheduleCommand: class {},
  GetScheduleCommand: class {},
  ListSchedulesCommand: class {},
  CreateScheduleGroupCommand: class {},
}));

const { httpClient } = await import("../helpers/http.js");
const { countQueries } = await import("../helpers/queryCounter.js");

const VENDORS = [IDS.users.vendor_alpha, IDS.users.vendor_beta, IDS.users.vendor_gamma];
const made = { rfqIds: [] };

const until = async (pred, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

async function publishableRfq() {
  const rfq = await db.one(
    `INSERT INTO tbl_rfq
       (rfq_no, comment, company_name, response_email, contact_name, contact_number,
        bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
        hospitality_company_id, hotel_id, process_id, is_tender, title)
     VALUES ((SELECT COALESCE(MAX(rfq_no), 8000000) + 1 FROM tbl_rfq), '', '', '', '', '',
             '2099-01-01 00:00:00', '', 0, 4, $1, $1, NOW(), $2, $3, $4, 0, 'publish-off-path')
     RETURNING id, rfq_no`,
    [IDS.users.a1_proc_buyer, IDS.hospitality.A, IDS.hotels.A1, IDS.processes.A_P1]
  );
  made.rfqIds.push(rfq.id);
  for (const variant of [1, 2]) {
    await db.none(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0)`, [rfq.id, variant]);
    for (const v of VENDORS) {
      await db.none(
        `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1, $2, $3, 0)`,
        [rfq.id, variant, v]);
    }
  }
  return rfq;
}

const signed = (client, body) => client.post("/api/v1/rfq/internal/publish")
  .set("x-scheduler-signature",
    crypto.createHmac("sha256", process.env.SCHEDULER_SECRET).update(JSON.stringify(body)).digest("hex"))
  .set("x-schedule-id", "test-schedule")
  .send(body);

describe("POST /rfq/internal/publish — notifications after the response", () => {
  let client;

  beforeAll(async () => {
    expect(process.env.SCHEDULER_SECRET).toBeTruthy();
    client = await httpClient(null);
  });

  afterEach(() => {
    calls.publish.length = 0;
    calls.vendor.length = 0;
    publishEmailShouldThrow = false;
    publishEmailGate = Promise.resolve();
  });

  afterAll(async () => {
    if (!made.rfqIds.length) return;
    await db.none(`DELETE FROM tbl_vendor_rfq_tokens_non_login WHERE rfq_no = ANY($1::int[])`, [made.rfqIds]);
    await db.none(`DELETE FROM tbl_notifications WHERE additional_data->>'rfq_id' = ANY($1::text[])`, [made.rfqIds.map(String)]).catch(() => {});
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [made.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [made.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [made.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [made.rfqIds]);
  });

  it("responds before the notifications run, with the publish already committed", async () => {
    const rfq = await publishableRfq();
    publishEmailGate = new Promise((r) => { releasePublishEmail = r; });

    let tokenInserts = 0;
    const { result: res } = await countQueries(async () => {
      const response = await signed(client, { rfqId: rfq.id, rfq_no: rfq.rfq_no });

      // Response is back; the published email is still blocked on the gate.
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 1, published: true, rfqId: rfq.id });
      expect(response.body).not.toHaveProperty("notify");
      expect(calls.publish).toHaveLength(0);
      const row = await db.one(`SELECT status, is_published FROM tbl_rfq WHERE id = $1`, [rfq.id]);
      expect(row).toEqual({ status: 1, is_published: 1 });

      releasePublishEmail();
      expect(await until(() => calls.vendor.length === 1)).toBe(true);
      return response;
    }).then((r) => {
      tokenInserts = r.statements.filter((q) => /insert into "?tbl_vendor_rfq_tokens_non_login"?/i.test(q)).length;
      return r;
    });

    expect(res.status).toBe(200);
    expect(calls.publish).toHaveLength(1);
    // Every vendor invited once, each with its own token…
    const invited = calls.vendor[0].vendors;
    expect(invited.map((v) => v.user_id).sort()).toEqual([...VENDORS].sort());
    expect(new Set(invited.map((v) => String(v.token))).size).toBe(VENDORS.length);
    const tokens = await db.any(
      `SELECT vendor_id, token FROM tbl_vendor_rfq_tokens_non_login WHERE rfq_no = $1 ORDER BY vendor_id`, [rfq.id]);
    expect(tokens.map((t) => t.vendor_id)).toEqual([...VENDORS].sort());
    // …written by ONE statement, not one per vendor.
    expect(tokenInserts).toBe(1);
  });

  it("a notification failure after the response is logged, not surfaced", async () => {
    const rfq = await publishableRfq();
    publishEmailShouldThrow = true;
    const res = await signed(client, { rfqId: rfq.id, rfq_no: rfq.rfq_no });
    expect(res.status).toBe(200);
    expect(res.body.published).toBe(true);
    // Same scope as when it ran in-line: one try/catch around the whole
    // notification step, so a throw there is caught + logged and the rest of
    // that step (the vendor leg) is skipped — but the publish stands.
    await new Promise((r) => setTimeout(r, 200));
    expect(calls.vendor).toHaveLength(0);
    const row = await db.one(`SELECT is_published FROM tbl_rfq WHERE id = $1`, [rfq.id]);
    expect(row.is_published).toBe(1);
  });
});
