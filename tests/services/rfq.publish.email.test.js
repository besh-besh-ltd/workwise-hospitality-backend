// Wave-1 step-3.5 test: vendor publish-email recipient list.
//
// Surface tested: cronManager.publishRfqById is invoked by the AWS Scheduler
// at the RFQ's tender_publish_date. Internally it:
//   1. flips tbl_rfq.is_published → 1
//   2. sends `sendRfqPublishedNotification` to approval users + creator
//   3. iterates over products → builds a unique vendor map → sends
//      `sendVendorRfqNotification({ ... vendors: [{user_id, email, ...}] })`
//
// We mock the approvalEmails module to capture the call payloads, build a
// "publishable" RFQ with two products + multiple vendors via direct INSERT,
// invoke the production `publishRfqById`, and assert:
//   - is_published = 1
//   - sendVendorRfqNotification got every distinct vendor across products,
//     deduplicated, AND only those vendors (no cross-RFQ leak)
//   - sendRfqPublishedNotification got the creator
//
// Per CONVENTIONS.md: production code is invoked end-to-end. The only mock
// is the email transport so we can assert recipients.

import { describe, it, expect, afterAll, beforeEach, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";

// Captured calls — populated by the mock factory below.
const emailCalls = { vendor: [], publish: [] };

jest.unstable_mockModule(
  "../../app/helper/sendEmailFunctions/approvalEmails.js",
  () => ({
    sendRfqCreationNotification: async () => {},
    sendApprovalStepNotification: async () => {},
    sendRfqReadyToPublishNotification: async () => {},
    sendRfqPublishedNotification: async (args) => {
      emailCalls.publish.push(args);
    },
    sendVendorRfqNotification: async (args) => {
      emailCalls.vendor.push(args);
    },
    sendVendorAutoAddedToRfqNotification: async () => {},
    sendVendorBulkRfqJoinNotification: async () => {},
    sendRfqClosedHeadsUpNotification: async () => {},
    sendApprovalCancelledNotification: async () => {},
    sendPolicyChangeNotification: async () => {},
    sendApproverRemovedNotification: async () => {},
    sendApprovalStandsNotification: async () => {},
    sendApproverAddedMidFlightNotification: async () => {},
  })
);

// Mock cronManager's AWS-Scheduler operations so the test doesn't try to
// reach EventBridge. The export under test (`publishRfqById`) is the same
// real function — we only stub out side-channel scheduler calls it never
// exercises, just to keep the import graph quiet.
jest.unstable_mockModule(
  "@aws-sdk/client-scheduler",
  () => ({
    SchedulerClient: class { send = async () => ({}); },
    CreateScheduleCommand: class {},
    UpdateScheduleCommand: class {},
    DeleteScheduleCommand: class {},
    GetScheduleCommand: class {},
    ListSchedulesCommand: class {},
    CreateScheduleGroupCommand: class {},
  })
);

const { publishRfqById } = await import("../../app/helper/cronManager.js");

afterAll(async () => {
  await closeDb();
});

const inserted = { rfqIds: [], tokenRfqIds: [] };

beforeEach(() => {
  inserted.rfqIds = [];
  inserted.tokenRfqIds = [];
  emailCalls.vendor.length = 0;
  emailCalls.publish.length = 0;
});

afterEach(async () => {
  if (inserted.tokenRfqIds.length) {
    // Vendor RFQ tokens are written to tbl_vendor_rfq_tokens_non_login,
    // keyed by the RFQ's rfq_no (NOT id) — see rfqModel.insertVendorRfqToken.
    await db.none(
      `DELETE FROM tbl_vendor_rfq_tokens_non_login
       WHERE rfq_no IN (SELECT rfq_no FROM tbl_rfq WHERE id = ANY($1::int[]))`,
      [inserted.tokenRfqIds]
    );
  }
  if (!inserted.rfqIds.length) return;
  await db.none(
    `DELETE FROM tbl_approval_actions
     WHERE approval_instance_id IN (
       SELECT id FROM tbl_approval_instances
       WHERE entity_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_approval_step_approvers
     WHERE approval_instance_step_id IN (
       SELECT s.id FROM tbl_approval_instance_steps s
       JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
       WHERE i.entity_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_approval_instance_steps
     WHERE approval_instance_id IN (
       SELECT id FROM tbl_approval_instances WHERE entity_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_approval_instances WHERE entity_id = ANY($1::int[])`,
    [inserted.rfqIds]
  );
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
});

// ---- Helpers ---------------------------------------------------------------

const isoNow = () => new Date().toISOString().replace("T", " ").slice(0, 19);

async function makePublishableRfq({ vendorsByVariant }) {
  // Insert a Submitted RFQ in status=4 (READY_TO_PUBLISH) under hotel A1, P1.
  const rfq = await db.one(
    `INSERT INTO tbl_rfq
       (rfq_no, comment, company_name, response_email, contact_name, contact_number,
        bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
        hospitality_company_id, hotel_id, process_id, is_tender, title)
     VALUES ($1, '', '', '', '', '', $2, '', 0, 4, $3, $3, NOW(),
             $4, $5, $6, 0, 'publish-email-test')
     RETURNING id, rfq_no`,
    [
      8300000 + Math.floor(Math.random() * 100000),
      isoNow(),
      IDS.users.a1_proc_buyer,
      IDS.hospitality.A,
      IDS.hotels.A1,
      IDS.processes.A_P1,
    ]
  );
  inserted.rfqIds.push(rfq.id);
  inserted.tokenRfqIds.push(rfq.id);

  // Add product rows + vendor mappings.
  for (const [variantStr, vendorIds] of Object.entries(vendorsByVariant)) {
    const variant = parseInt(variantStr, 10);
    await db.none(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0)`,
      [rfq.id, variant]
    );
    for (const vid of vendorIds) {
      await db.none(
        `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
         VALUES ($1, $2, $3, 0)`,
        [rfq.id, variant, vid]
      );
    }
  }

  return rfq;
}

// ===========================================================================
//  publishRfqById — vendor recipient list
// ===========================================================================

describe("publishRfqById — vendor recipient list", () => {
  it("dedupes vendors mapped to multiple products + emails each unique vendor exactly once", async () => {
    // Two products. Vendor alpha is mapped to BOTH (cross-product). Vendor
    // beta is on product 1 only. Expected unique recipients: alpha, beta.
    const rfq = await makePublishableRfq({
      vendorsByVariant: {
        1: [IDS.users.vendor_alpha, IDS.users.vendor_beta],
        2: [IDS.users.vendor_alpha],
      },
    });

    const result = await publishRfqById(rfq.id, rfq.rfq_no);
    expect(result?.skipped).not.toBe(true);

    const after = await db.one(
      `SELECT is_published, status FROM tbl_rfq WHERE id=$1`, [rfq.id]
    );
    expect(after.is_published).toBe(1);

    // sendVendorRfqNotification fired exactly once with the dedup'd vendor list.
    expect(emailCalls.vendor.length).toBe(1);
    const vendorList = emailCalls.vendor[0].vendors;
    const ids = vendorList.map((v) => Number(v.user_id)).sort();
    expect(ids).toEqual(
      [IDS.users.vendor_alpha, IDS.users.vendor_beta].sort()
    );

    // Each vendor's product list reflects what they were mapped to.
    const alpha = vendorList.find((v) => Number(v.user_id) === IDS.users.vendor_alpha);
    const beta  = vendorList.find((v) => Number(v.user_id) === IDS.users.vendor_beta);
    // alpha was on both variants → 2 products in their list.
    expect(alpha.products.length).toBe(2);
    expect(beta.products.length).toBe(1);
  });

  it("does NOT email vendors of any OTHER RFQ (cross-RFQ isolation)", async () => {
    // Two RFQs: A has vendor_alpha+vendor_beta; B has vendor_gamma. Publishing
    // A must not include vendor_gamma in the recipient list.
    const rfqA = await makePublishableRfq({
      vendorsByVariant: { 1: [IDS.users.vendor_alpha, IDS.users.vendor_beta] },
    });
    await makePublishableRfq({
      vendorsByVariant: { 1: [IDS.users.vendor_gamma] },
    });

    await publishRfqById(rfqA.id, rfqA.rfq_no);
    expect(emailCalls.vendor.length).toBe(1);
    const ids = emailCalls.vendor[0].vendors.map((v) => Number(v.user_id));
    expect(ids).toContain(IDS.users.vendor_alpha);
    expect(ids).toContain(IDS.users.vendor_beta);
    expect(ids).not.toContain(IDS.users.vendor_gamma);
  });

  it("idempotent on re-publish: second publishRfqById call emits no second email batch", async () => {
    const rfq = await makePublishableRfq({
      vendorsByVariant: { 1: [IDS.users.vendor_alpha] },
    });

    await publishRfqById(rfq.id, rfq.rfq_no);
    expect(emailCalls.vendor.length).toBe(1);

    // Second call — RFQ already is_published=1, controller skips email work.
    const second = await publishRfqById(rfq.id, rfq.rfq_no);
    expect(second?.skipped).toBe(true);
    expect(second?.reason).toBe("already_published");
    expect(emailCalls.vendor.length).toBe(1); // unchanged
  });

  it("publish notification reaches the RFQ creator (sendRfqPublishedNotification recipients include them)", async () => {
    const rfq = await makePublishableRfq({
      vendorsByVariant: { 1: [IDS.users.vendor_alpha] },
    });

    await publishRfqById(rfq.id, rfq.rfq_no);
    expect(emailCalls.publish.length).toBe(1);
    const users = emailCalls.publish[0].users;
    const emails = users.map((u) => u.email);
    expect(emails).toContain("a1.proc.buyer@test.local");
  });

  it.todo(
    "F-PUBLISH-002: insertVendorRfqToken must dedupe — second publishRfqById on same vendor MUST NOT create duplicate token rows in tbl_rfq_publish_tokens (assert one row per (vendor, rfq) after retry)"
  );
});
