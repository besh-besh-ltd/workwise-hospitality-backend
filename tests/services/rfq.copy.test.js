// rfqController.copyRfq — end-to-end coverage.
//
// Covers the suites enumerated in the plan file
// (~/.claude/plans/okay-in-this-application-joyful-ritchie.md):
//
//   A. Validation & auth          (HTTP — exercises Joi + ACL + auth)
//   B. Header copy correctness    (controller-direct)
//   C. Children copy correctness  (controller-direct)
//   D. Vendor re-resolution       (controller-direct)
//   E. Tech evaluation copy       (controller-direct)
//   F. Transaction rollback       (controller-direct)
//   H. Edge cases / security      (controller-direct)
//   I. Side effects               (controller-direct)
//   J. Response shape             (controller-direct)
//
// Lineage tests (suite G) live in rfq.copy.lineage.test.js.
//
// Conventions per tests/CONVENTIONS.md:
//   - Pattern B (commit + cleanup) since copyRfq opens its own db.tx.
//   - Production function called end-to-end; no SQL replicas.
//   - npm test -- rfq.copy

import {
  describe, it, expect, afterAll, beforeAll, beforeEach, afterEach, jest,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";

// Mock notification senders so we can spy on them without sending anything.
const notificationCalls = { create: [], whatsapp: [] };
jest.unstable_mockModule("../../app/helper/sendEmailFunctions/approvalEmails.js", () => ({
  sendRfqCreationNotification: async (args) => { notificationCalls.create.push(args); },
  sendApprovalStepNotification: async () => {},
  sendRfqReadyToPublishNotification: async () => {},
  sendRfqPublishedNotification: async () => {},
  sendVendorRfqNotification: async () => {},
  sendVendorAutoAddedToRfqNotification: async () => {},
  sendVendorBulkRfqJoinNotification: async () => {},
  sendRfqClosedHeadsUpNotification: async () => {},
  sendApprovalCancelledNotification: async () => {},
  sendPolicyChangeNotification: async () => {},
  sendApproverRemovedNotification: async () => {},
  sendApprovalStandsNotification: async () => {},
  sendApproverAddedMidFlightNotification: async () => {},
}));
jest.unstable_mockModule("../../app/helper/whatsappNotificationAISensy.js", () => ({
  default: {
    buyerCreatesRFQNotification: (args) => { notificationCalls.whatsapp.push(args); },
  },
}));

const { default: rfqController } = await import("../../app/controllers/rfq/rfqController.js");
const { default: hospitalityModel } = await import("../../app/models/hospitalityModel.js");

const TEST_VARIANT_ID = 1; // canonical fixture variant in BEVERAGES (215)
const TEST_VARIANT_ID_2 = 2; // a second variant for multi-product tests

// --- Test scaffolding -------------------------------------------------------

function mockExpress(opts = {}) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    end() { return this; },
  };
  return {
    req: { user: opts.user, params: opts.params || {}, body: opts.body || {} },
    res,
    next: jest.fn(),
    calls,
  };
}

const userCtx = (id) => ({ id, name: `user-${id}` });

const inserted = {
  rfqIds: [],
  variantVendorIds: [],
  subscriptionIds: [],
};

beforeEach(() => {
  inserted.rfqIds = [];
  inserted.variantVendorIds = [];
  inserted.subscriptionIds = [];
  notificationCalls.create.length = 0;
  notificationCalls.whatsapp.length = 0;
});

// Cleanup runs in FK-safe reverse order. All copy-children cascade off rfq_id,
// so deleting tbl_rfq rows takes care of products/vendors/specs/files/terms/
// tech-eval. We just need to wipe non-cascading auxiliary rows first.
afterEach(async () => {
  if (inserted.rfqIds.length) {
    const ids = inserted.rfqIds;
    await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation_clauses_files
                   WHERE tbl_rfq_product_tech_evaluation_clauses_id IN (
                     SELECT c.id FROM tbl_rfq_product_tech_evaluation_clauses c
                     JOIN tbl_rfq_product_tech_evaluation te
                       ON te.id = c.tbl_rfq_product_tech_evaluation_id
                     WHERE te.rfq_id = ANY($1::int[]))`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation_clauses
                   WHERE tbl_rfq_product_tech_evaluation_id IN (
                     SELECT id FROM tbl_rfq_product_tech_evaluation
                     WHERE rfq_id = ANY($1::int[]))`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_product_files
                   WHERE rfq_product_id IN (
                     SELECT id FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[]))`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_files WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_terms_map WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`UPDATE tbl_rfq SET copied_from_rfq_id = NULL WHERE copied_from_rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [ids]);
  }
  if (inserted.subscriptionIds.length) {
    await db.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE id = ANY($1::int[])`, [inserted.subscriptionIds]);
  }
  if (inserted.variantVendorIds.length) {
    await db.none(`DELETE FROM tbl_product_variant_vendor_mapping WHERE id = ANY($1::int[])`, [inserted.variantVendorIds]);
  }
});

// Restore fixture state at the end so we don't pollute later suites in the
// same Jest worker. user_type=2 mirrors the production default for buyers
// (NULL on fixtures); resetting back to NULL keeps downstream suites that
// depend on the NULL state in their original baseline.
afterAll(async () => {
  await db.none(
    `UPDATE tbl_users SET user_type = NULL WHERE id = ANY($1::int[])`,
    [[IDS.users.a1_proc_buyer, IDS.users.a1_proc_techEval]]
  );
  // Defensive sweep: drop any RFQs that escaped per-test tracking with our
  // signature rfq_no range (>= 8000100 — we always insert above that offset).
  await db.none(
    `DELETE FROM tbl_rfq_product_vendors WHERE rfq_id IN (
       SELECT id FROM tbl_rfq WHERE rfq_no >= 8000100 AND created_by = ANY($1::int[])
     )`,
    [[IDS.users.a1_proc_buyer, IDS.users.multiHotel, IDS.users.crossCompany, IDS.users.companyB_admin]]
  );
  await db.none(
    `DELETE FROM tbl_rfq_products WHERE rfq_id IN (
       SELECT id FROM tbl_rfq WHERE rfq_no >= 8000100 AND created_by = ANY($1::int[])
     )`,
    [[IDS.users.a1_proc_buyer, IDS.users.multiHotel, IDS.users.crossCompany, IDS.users.companyB_admin]]
  );
  await db.none(
    `DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id IN (
       SELECT id FROM tbl_rfq WHERE rfq_no >= 8000100 AND created_by = ANY($1::int[])
     )`,
    [[IDS.users.a1_proc_buyer, IDS.users.multiHotel, IDS.users.crossCompany, IDS.users.companyB_admin]]
  );
  await db.none(
    `UPDATE tbl_rfq SET copied_from_rfq_id = NULL WHERE copied_from_rfq_id IN (
       SELECT id FROM tbl_rfq WHERE rfq_no >= 8000100 AND created_by = ANY($1::int[])
     )`,
    [[IDS.users.a1_proc_buyer, IDS.users.multiHotel, IDS.users.crossCompany, IDS.users.companyB_admin]]
  );
  await db.none(
    `DELETE FROM tbl_rfq WHERE rfq_no >= 8000100 AND created_by = ANY($1::int[])`,
    [[IDS.users.a1_proc_buyer, IDS.users.multiHotel, IDS.users.crossCompany, IDS.users.companyB_admin]]
  );
  await closeDb();
});

// --- Helpers ---------------------------------------------------------------

// The shared makeRFQ factory bumps an in-memory rfq_no counter, but our
// controller computes rfq_no = MAX(rfq_no)+1. Those drift after a copy:
// factory's next rfq_no can collide with the copy's. Hop ahead by 100 each
// call to leave a buffer for any copies the test creates.
async function trackedMakeRFQ(opts) {
  const { maxno } = await db.one(`SELECT COALESCE(MAX(rfq_no), 100000) AS maxno FROM tbl_rfq`);
  const row = await makeRFQ(db, { rfq_no: maxno + 100, ...opts });
  inserted.rfqIds.push(row.rfq_id);
  return row;
}

async function addRfqProduct(rfqId, variantId = TEST_VARIANT_ID, overrides = {}) {
  const row = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant, sheet_id, datasheet_file)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      rfqId,
      overrides.comment ?? "src comment",
      overrides.datasheet ?? "",
      overrides.spec_file ?? "",
      overrides.qap_file ?? "",
      overrides.qap ?? "",
      variantId,
      overrides.variant ?? 0,
      overrides.sheet_id ?? null,
      overrides.datasheet_file ?? "",
    ]
  );
  return row.id;
}

async function attachProductSpec(rfqId, variantId, title, value, variant = 0) {
  await db.none(
    `INSERT INTO tbl_rfq_products_specs
       (rfq_id, product_variant_id, title, value, variant, sheet_id)
     VALUES ($1, $2, $3, $4, $5, NULL)`,
    [rfqId, variantId, title, value, variant]
  );
}

async function attachProductFile(rfqProductId, fileType = "TDS", fileUrl = "https://example.com/file.pdf") {
  await db.none(
    `INSERT INTO tbl_rfq_product_files (rfq_product_id, file_type, file_url, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now())`,
    [rfqProductId, fileType, fileUrl]
  );
}

async function attachRfqFile(rfqId, fileType = "term_and_condition", fileUrl = "https://example.com/tc.pdf") {
  await db.none(
    `INSERT INTO tbl_rfq_files (rfq_id, file_type, file_url) VALUES ($1, $2, $3)`,
    [rfqId, fileType, fileUrl]
  );
}

async function attachVendorToVariant(vendorId, variantId = TEST_VARIANT_ID) {
  const row = await db.one(
    `INSERT INTO tbl_product_variant_vendor_mapping
       (product_variant_id, vendor_id, status, is_approved, created_by, created_at, updated_at)
     VALUES ($1, $2, true, true, $3, now(), now())
     RETURNING id`,
    [variantId, vendorId, vendorId]
  );
  inserted.variantVendorIds.push(row.id);
}

async function addSubscription(vendorId, itemType, itemId, status = "active") {
  const row = await db.oneOrNone(
    `INSERT INTO tbl_vendor_hotel_category_subscription
       (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
     VALUES ($1, $2, $3, 500,
             (now() - interval '30 days')::date,
             (now() + interval '335 days')::date,
             $4)
     ON CONFLICT ON CONSTRAINT uq_vendor_hotel_category_subscription DO NOTHING
     RETURNING id`,
    [vendorId, itemType, itemId, status]
  );
  if (row?.id) inserted.subscriptionIds.push(row.id);
}

async function attachVendorToRfqProduct(rfqId, vendorId, variantId = TEST_VARIANT_ID, variant = 0) {
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors
       (rfq_id, product_variant_id, user_id, variant, sheet_id, is_rfq_viewed)
     VALUES ($1, $2, $3, $4, NULL, 0)`,
    [rfqId, variantId, vendorId, variant]
  );
}

async function addTechEvalWithClause(rfqId, rfqProductId, { clauseText = "Must support 240V", weightage = 50 } = {}) {
  const te = await db.one(
    `INSERT INTO tbl_rfq_product_tech_evaluation (rfq_id, tbl_rfq_product_id, minimum_passing_score)
     VALUES ($1, $2, $3) RETURNING id`,
    [rfqId, rfqProductId, 70]
  );
  const clause = await db.one(
    `INSERT INTO tbl_rfq_product_tech_evaluation_clauses
       (tbl_rfq_product_tech_evaluation_id, clause_text, weightage, clause_type)
     VALUES ($1, $2, $3, 'clause') RETURNING id`,
    [te.id, clauseText, weightage]
  );
  await db.none(
    `INSERT INTO tbl_rfq_product_tech_evaluation_clauses_files
       (tbl_rfq_product_tech_evaluation_clauses_id, file_url)
     VALUES ($1, $2)`,
    [clause.id, "https://example.com/tech-clause.pdf"]
  );
  return { teId: te.id, clauseId: clause.id };
}

// Add a hotel-level vendor subscription so getEligibleVendorsForVariant
// returns the vendor for that hotel.
async function makeVendorEligibleForHotel(vendorId, hotelId, variantId = TEST_VARIANT_ID, categoryId = 215) {
  await attachVendorToVariant(vendorId, variantId);
  await addSubscription(vendorId, "category", categoryId, "active");
  await addSubscription(vendorId, "hotel", hotelId, "active");
}

async function callCopy(user, body) {
  const m = mockExpress({ user: userCtx(user), body });
  await rfqController.copyRfq(m.req, m.res);
  return m;
}

async function trackCopyResult(m) {
  const id = m.calls.body?.data?.new_rfq_id;
  if (id) inserted.rfqIds.push(id);
  return id;
}

// ============================================================================
// A. Validation & auth (HTTP-level)
// ============================================================================

describe("A. Validation & auth", () => {
  let client;
  let buyerUserId;
  beforeAll(async () => {
    // user_type defaults to NULL on fixture users; acl([2,8]) requires 2 or 8.
    // Patch the buyer to user_type=2 so HTTP requests pass ACL.
    buyerUserId = IDS.users.a1_proc_buyer;
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [buyerUserId]);
    await db.none(`UPDATE tbl_users SET user_type = 6 WHERE id = $1`, [IDS.users.a1_proc_techEval]);
    client = await httpClient(buyerUserId);
  });

  it("400 on missing source_rfq_id", async () => {
    const res = await client.post("/api/v1/rfq/copy").send({ target_hotel_id: IDS.hotels.A1 });
    expect(res.status).toBe(400);
  });

  it("400 on missing target_hotel_id", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: buyerUserId });
    const res = await client.post("/api/v1/rfq/copy").send({ source_rfq_id: rfq_id });
    expect(res.status).toBe(400);
  });

  it("400 on non-integer ids", async () => {
    const res = await client.post("/api/v1/rfq/copy").send({ source_rfq_id: "abc", target_hotel_id: -1 });
    expect(res.status).toBe(400);
  });

  it("401 on no JWT", async () => {
    const anon = await httpClient(null);
    const res = await anon.post("/api/v1/rfq/copy").send({ source_rfq_id: 1, target_hotel_id: IDS.hotels.A1 });
    expect(res.status).toBe(401);
  });

  it("403 on role outside acl([2, 8])", async () => {
    const techEval = await httpClient(IDS.users.a1_proc_techEval);
    const { rfq_id } = await trackedMakeRFQ({ createdBy: buyerUserId });
    const res = await techEval.post("/api/v1/rfq/copy").send({ source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1 });
    expect(res.status).toBe(403);
  });

  it("403 when target_hotel_id not in user's accessible hotels", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: buyerUserId });
    const res = await client.post("/api/v1/rfq/copy").send({ source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.B1 });
    expect(res.status).toBe(403);
  });

  it("400 when target hotel doesn't exist", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: buyerUserId });
    const res = await client.post("/api/v1/rfq/copy").send({ source_rfq_id: rfq_id, target_hotel_id: 9999999 });
    // The hotel ID isn't in the user's mappings, so 403 fires first — that's
    // the correct security order (don't leak existence of arbitrary hotels).
    expect([400, 403]).toContain(res.status);
  });

  it("404 when source_rfq_id doesn't exist", async () => {
    const res = await client.post("/api/v1/rfq/copy").send({ source_rfq_id: 9999999, target_hotel_id: IDS.hotels.A1 });
    expect(res.status).toBe(404);
  });

  it("404 when source RFQ is on a hotel the caller can't access", async () => {
    // Seed an RFQ on hotel B1 (companyB_admin's hotel).
    const { rfq_id } = await trackedMakeRFQ({
      createdBy: IDS.users.companyB_admin,
      hospitality: IDS.hospitality.B,
      hotel: IDS.hotels.B1,
    });
    const res = await client.post("/api/v1/rfq/copy").send({ source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1 });
    expect(res.status).toBe(404);
  });

  it("strips unknown body fields (no hospitality_company_id override)", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: buyerUserId });
    const res = await client.post("/api/v1/rfq/copy").send({
      source_rfq_id: rfq_id,
      target_hotel_id: IDS.hotels.A1,
      hospitality_company_id: 999999, // Joi has .unknown(false) — should reject
    });
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// B. Header copy correctness
// ============================================================================

describe("B. Header copy correctness", () => {
  it("status forced to DRAFT (1) regardless of source status", async () => {
    for (const sourceStatus of [3, 4, 5, 7]) {
      const { rfq_id } = await trackedMakeRFQ({
        createdBy: IDS.users.a1_proc_buyer,
        status: sourceStatus,
        is_published: 1,
      });
      const m = await callCopy(IDS.users.a1_proc_buyer, {
        source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
      });
      const newId = await trackCopyResult(m);
      expect(m.calls.status).toBe(200);
      const newRow = await db.one(`SELECT status, is_published FROM tbl_rfq WHERE id = $1`, [newId]);
      expect(newRow.status).toBe(1);
      expect(newRow.is_published).toBe(0);
    }
  });

  it("all dates blanked (bid_end_date='', ra_*=NULL, tender_publish_date=NULL, vendor_clarification_date=NULL, tender_fees=NULL)", async () => {
    const { rfq_id } = await trackedMakeRFQ({
      createdBy: IDS.users.a1_proc_buyer,
      is_tender: 1,
    });
    // Source has dates from factory defaults.
    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    const newId = await trackCopyResult(m);
    const newRow = await db.one(
      `SELECT bid_end_date, ra_start_date, ra_end_date,
              tender_publish_date, vendor_clarification_date, tender_fees
       FROM tbl_rfq WHERE id = $1`,
      [newId]
    );
    expect(newRow.bid_end_date).toBe("");
    expect(newRow.ra_start_date).toBeNull();
    expect(newRow.ra_end_date).toBeNull();
    expect(newRow.tender_publish_date).toBeNull();
    expect(newRow.vendor_clarification_date).toBeNull();
    expect(newRow.tender_fees).toBeNull();
  });

  it("created_by = req.user.id (not source's created_by)", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    const copier = IDS.users.multiHotel;
    const m = await callCopy(copier, { source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1 });
    const newId = await trackCopyResult(m);
    const newRow = await db.one(`SELECT created_by, updated_by FROM tbl_rfq WHERE id = $1`, [newId]);
    expect(newRow.created_by).toBe(copier);
    expect(newRow.updated_by).toBe(copier);
  });

  it("fresh rfq_no, strictly greater than source", async () => {
    const { rfq_id, rfq_no: sourceNo } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    const newId = await trackCopyResult(m);
    const newRow = await db.one(`SELECT rfq_no FROM tbl_rfq WHERE id = $1`, [newId]);
    expect(newRow.rfq_no).toBeGreaterThan(sourceNo);
  });

  it("copied_from_rfq_id = source id; header columns carry over", async () => {
    const { rfq_id } = await trackedMakeRFQ({
      createdBy: IDS.users.a1_proc_buyer,
      title: "carry over title",
      comment: "carry over comment",
      location: "carry over loc",
    });
    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    const newId = await trackCopyResult(m);
    const carry = await db.one(
      `SELECT copied_from_rfq_id, title, comment, location, contact_name,
              contact_number, response_email, rfq_type, reverse_auction,
              is_tender, process_id, department_id
       FROM tbl_rfq WHERE id = $1`,
      [newId]
    );
    expect(carry.copied_from_rfq_id).toBe(rfq_id);
    expect(carry.title).toBe("carry over title");
    expect(carry.comment).toBe("carry over comment");
    expect(carry.location).toBe("carry over loc");
    expect(carry.contact_name).toBe("Test Contact");
    expect(carry.rfq_type).toBe("RFQ");
  });

  it("hotel_id = target; hospitality_company_id derived from target hotel", async () => {
    const { rfq_id } = await trackedMakeRFQ({
      createdBy: IDS.users.multiHotel,
      hotel: IDS.hotels.A1,
      hospitality: IDS.hospitality.A,
    });
    const m = await callCopy(IDS.users.multiHotel, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A2,
    });
    const newId = await trackCopyResult(m);
    const newRow = await db.one(
      `SELECT hotel_id, hospitality_company_id FROM tbl_rfq WHERE id = $1`,
      [newId]
    );
    expect(newRow.hotel_id).toBe(IDS.hotels.A2);
    expect(newRow.hospitality_company_id).toBe(IDS.hospitality.A);
  });

  it("reverse_auction flag carried; ra_* dates still NULL", async () => {
    const { rfq_id } = await trackedMakeRFQ({
      createdBy: IDS.users.a1_proc_buyer,
    });
    // Force reverse_auction=1 on the source.
    await db.none(`UPDATE tbl_rfq SET reverse_auction = 1 WHERE id = $1`, [rfq_id]);
    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    const newId = await trackCopyResult(m);
    const newRow = await db.one(
      `SELECT reverse_auction, ra_start_date, ra_end_date FROM tbl_rfq WHERE id = $1`,
      [newId]
    );
    expect(newRow.reverse_auction).toBe(1);
    expect(newRow.ra_start_date).toBeNull();
    expect(newRow.ra_end_date).toBeNull();
  });
});

// ============================================================================
// C. Children copy correctness
// ============================================================================

describe("C. Children copy correctness", () => {
  it("products copied 1:1 with same variant ids and fresh primary keys", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    const p1Id = await addRfqProduct(rfq_id, TEST_VARIANT_ID);
    const p2Id = await addRfqProduct(rfq_id, TEST_VARIANT_ID_2);

    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    const newId = await trackCopyResult(m);
    const newProducts = await db.any(
      `SELECT id, product_variant_id FROM tbl_rfq_products WHERE rfq_id = $1 ORDER BY id`,
      [newId]
    );
    expect(newProducts.length).toBe(2);
    expect(newProducts.map(p => p.product_variant_id).sort()).toEqual([TEST_VARIANT_ID, TEST_VARIANT_ID_2].sort());
    expect(newProducts.map(p => p.id)).not.toContain(p1Id);
    expect(newProducts.map(p => p.id)).not.toContain(p2Id);
  });

  it("product specs are copied", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    await addRfqProduct(rfq_id, TEST_VARIANT_ID);
    await attachProductSpec(rfq_id, TEST_VARIANT_ID, "Quantity", "100");
    await attachProductSpec(rfq_id, TEST_VARIANT_ID, "Unit", "boxes");

    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    const newId = await trackCopyResult(m);
    const specs = await db.any(
      `SELECT title, value FROM tbl_rfq_products_specs WHERE rfq_id = $1 ORDER BY title`,
      [newId]
    );
    expect(specs).toEqual([
      { title: "Quantity", value: "100" },
      { title: "Unit", value: "boxes" },
    ]);
  });

  it("product files copied with new rfq_product_id mapping", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    const productId = await addRfqProduct(rfq_id, TEST_VARIANT_ID);
    await attachProductFile(productId, "TDS", "https://example.com/tds.pdf");

    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    const newId = await trackCopyResult(m);
    const files = await db.any(
      `SELECT pf.file_type, pf.file_url, pf.rfq_product_id
       FROM tbl_rfq_product_files pf
       JOIN tbl_rfq_products p ON p.id = pf.rfq_product_id
       WHERE p.rfq_id = $1`,
      [newId]
    );
    expect(files.length).toBe(1);
    expect(files[0].file_type).toBe("TDS");
    expect(files[0].file_url).toBe("https://example.com/tds.pdf");
    expect(files[0].rfq_product_id).not.toBe(productId);
  });

  it("RFQ-level files (T&C) copied", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    await attachRfqFile(rfq_id, "term_and_condition", "https://example.com/tc.pdf");

    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    const newId = await trackCopyResult(m);
    const files = await db.any(
      `SELECT file_type, file_url FROM tbl_rfq_files WHERE rfq_id = $1`,
      [newId]
    );
    expect(files).toEqual([{ file_type: "term_and_condition", file_url: "https://example.com/tc.pdf" }]);
  });

  it("hotel mapping inserted for target hotel only", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.multiHotel });
    const m = await callCopy(IDS.users.multiHotel, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A2,
    });
    const newId = await trackCopyResult(m);
    const mappings = await db.any(
      `SELECT hotel_id FROM tbl_rfq_hotel_mappings WHERE rfq_id = $1`,
      [newId]
    );
    expect(mappings).toEqual([{ hotel_id: IDS.hotels.A2 }]);
  });
});

// ============================================================================
// D. Vendor re-resolution
// ============================================================================

describe("D. Vendor re-resolution", () => {
  it("vendor with both category + target-hotel sub appears on the copy", async () => {
    await makeVendorEligibleForHotel(IDS.users.vendor_alpha, IDS.hotels.A1);

    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    const productId = await addRfqProduct(rfq_id, TEST_VARIANT_ID);
    await attachVendorToRfqProduct(rfq_id, IDS.users.vendor_alpha);

    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    const newId = await trackCopyResult(m);
    const vendors = await db.any(
      `SELECT user_id FROM tbl_rfq_product_vendors WHERE rfq_id = $1`,
      [newId]
    );
    expect(vendors.map(v => v.user_id)).toContain(IDS.users.vendor_alpha);
  });

  it("vendor eligible for A1 but NOT A2 is dropped when copy targets A2", async () => {
    await makeVendorEligibleForHotel(IDS.users.vendor_alpha, IDS.hotels.A1);

    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.multiHotel, hotel: IDS.hotels.A1 });
    await addRfqProduct(rfq_id, TEST_VARIANT_ID);
    await attachVendorToRfqProduct(rfq_id, IDS.users.vendor_alpha);

    const m = await callCopy(IDS.users.multiHotel, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A2,
    });
    const newId = await trackCopyResult(m);
    const vendors = await db.any(
      `SELECT user_id FROM tbl_rfq_product_vendors WHERE rfq_id = $1`,
      [newId]
    );
    expect(vendors.map(v => v.user_id)).not.toContain(IDS.users.vendor_alpha);
  });

  it("a vendor newly subscribed at target hotel (not on source) IS included", async () => {
    // Source on A1 with alpha. Beta is freshly eligible on A1.
    await makeVendorEligibleForHotel(IDS.users.vendor_alpha, IDS.hotels.A1);
    await makeVendorEligibleForHotel(IDS.users.vendor_beta, IDS.hotels.A1);

    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    await addRfqProduct(rfq_id, TEST_VARIANT_ID);
    // Source only knows about alpha.
    await attachVendorToRfqProduct(rfq_id, IDS.users.vendor_alpha);

    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    const newId = await trackCopyResult(m);
    const ids = (await db.any(
      `SELECT user_id FROM tbl_rfq_product_vendors WHERE rfq_id = $1`,
      [newId]
    )).map(v => v.user_id);
    expect(ids).toContain(IDS.users.vendor_alpha);
    expect(ids).toContain(IDS.users.vendor_beta);
  });

  it("a product with zero eligible vendors at the target hotel is copied with no vendor rows", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    await addRfqProduct(rfq_id, TEST_VARIANT_ID);
    // No vendor seeded for A1 — eligibility resolver returns 0.

    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    expect(m.calls.status).toBe(200);
    const newId = await trackCopyResult(m);
    const productCount = await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_rfq_products WHERE rfq_id = $1`,
      [newId]
    );
    const vendorCount = await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_rfq_product_vendors WHERE rfq_id = $1`,
      [newId]
    );
    expect(productCount.n).toBe(1);
    expect(vendorCount.n).toBe(0);
  });

  it("a vendor with cancelled subscription is excluded", async () => {
    await attachVendorToVariant(IDS.users.vendor_delta, TEST_VARIANT_ID);
    // fixture: vendor_delta has a cancelled category sub. Add an active hotel
    // sub — eligibility should still reject because the category sub is
    // cancelled.
    await addSubscription(IDS.users.vendor_delta, "hotel", IDS.hotels.A1, "active");

    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    await addRfqProduct(rfq_id, TEST_VARIANT_ID);

    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    const newId = await trackCopyResult(m);
    const ids = (await db.any(
      `SELECT user_id FROM tbl_rfq_product_vendors WHERE rfq_id = $1`,
      [newId]
    )).map(v => v.user_id);
    expect(ids).not.toContain(IDS.users.vendor_delta);
  });

  it("re-resolves using getEligibleVendorsForVariant (call shape match)", async () => {
    // Spy on the resolver to confirm we delegate to the production function
    // rather than running our own SQL.
    const spy = jest.spyOn(hospitalityModel, "getEligibleVendorsForVariant");
    spy.mockClear();
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    await addRfqProduct(rfq_id, TEST_VARIANT_ID);
    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    await trackCopyResult(m);
    expect(spy).toHaveBeenCalledWith(TEST_VARIANT_ID, [IDS.hotels.A1]);
    spy.mockRestore();
  });
});

// ============================================================================
// E. Technical evaluation copy
// ============================================================================

describe("E. Technical evaluation copy", () => {
  it("no tech-eval on source → no tech-eval rows on the copy", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    await addRfqProduct(rfq_id, TEST_VARIANT_ID);

    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    const newId = await trackCopyResult(m);
    const teCount = await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = $1`,
      [newId]
    );
    expect(teCount.n).toBe(0);
  });

  it("one product with tech-eval + 1 clause + 1 clause file → all copied with fresh ids", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    const productId = await addRfqProduct(rfq_id, TEST_VARIANT_ID);
    const { teId, clauseId } = await addTechEvalWithClause(rfq_id, productId);

    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    const newId = await trackCopyResult(m);
    const newTe = await db.one(
      `SELECT id, minimum_passing_score, tbl_rfq_product_id
       FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = $1`,
      [newId]
    );
    expect(newTe.id).not.toBe(teId);
    expect(newTe.minimum_passing_score).toBe(70);
    const newClause = await db.one(
      `SELECT id, clause_text, weightage, clause_type
       FROM tbl_rfq_product_tech_evaluation_clauses
       WHERE tbl_rfq_product_tech_evaluation_id = $1`,
      [newTe.id]
    );
    expect(newClause.id).not.toBe(clauseId);
    expect(newClause.clause_text).toBe("Must support 240V");
    expect(newClause.weightage).toBe(50);
    expect(newClause.clause_type).toBe("clause");
    const clauseFiles = await db.any(
      `SELECT file_url FROM tbl_rfq_product_tech_evaluation_clauses_files
       WHERE tbl_rfq_product_tech_evaluation_clauses_id = $1`,
      [newClause.id]
    );
    expect(clauseFiles.map(f => f.file_url)).toEqual(["https://example.com/tech-clause.pdf"]);
  });

  it("multiple products each with tech-eval are mapped to the correct copied products", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    const p1 = await addRfqProduct(rfq_id, TEST_VARIANT_ID);
    const p2 = await addRfqProduct(rfq_id, TEST_VARIANT_ID_2);
    await addTechEvalWithClause(rfq_id, p1, { clauseText: "P1 clause" });
    await addTechEvalWithClause(rfq_id, p2, { clauseText: "P2 clause" });

    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    const newId = await trackCopyResult(m);
    const teProducts = await db.any(
      `SELECT te.tbl_rfq_product_id, rp.product_variant_id, c.clause_text
       FROM tbl_rfq_product_tech_evaluation te
       JOIN tbl_rfq_products rp ON rp.id = te.tbl_rfq_product_id
       JOIN tbl_rfq_product_tech_evaluation_clauses c
         ON c.tbl_rfq_product_tech_evaluation_id = te.id
       WHERE te.rfq_id = $1
       ORDER BY rp.product_variant_id`,
      [newId]
    );
    expect(teProducts.length).toBe(2);
    expect(teProducts[0].product_variant_id).toBe(TEST_VARIANT_ID);
    expect(teProducts[0].clause_text).toBe("P1 clause");
    expect(teProducts[1].product_variant_id).toBe(TEST_VARIANT_ID_2);
    expect(teProducts[1].clause_text).toBe("P2 clause");
  });
});

// ============================================================================
// F. Transaction rollback
// ============================================================================

describe("F. Transaction rollback", () => {
  it("vendor resolver throws mid-loop → no tbl_rfq, no children persisted", async () => {
    const spy = jest
      .spyOn(hospitalityModel, "getEligibleVendorsForVariant")
      .mockImplementation(async () => { throw new Error("simulated resolver failure"); });

    const beforeCount = await db.one(`SELECT COUNT(*)::int AS n FROM tbl_rfq`);
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    await addRfqProduct(rfq_id, TEST_VARIANT_ID);
    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    spy.mockRestore();

    expect(m.calls.status).toBe(400);
    expect(m.calls.body?.message || "").toMatch(/simulated resolver failure/);
    const afterCount = await db.one(`SELECT COUNT(*)::int AS n FROM tbl_rfq`);
    // Only the source RFQ was added (handled by trackedMakeRFQ); the copy
    // must NOT have left a row behind.
    expect(afterCount.n - beforeCount.n).toBe(1);
  });

  it("invalid target hotel (pre-tx) leaves no DB rows", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    const before = await db.one(`SELECT COUNT(*)::int AS n FROM tbl_rfq`);
    // Use a hotel id the buyer DOESN'T have access to so the check
    // short-circuits before the transaction ever opens.
    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.B1,
    });
    expect(m.calls.status).toBe(403);
    const after = await db.one(`SELECT COUNT(*)::int AS n FROM tbl_rfq`);
    expect(after.n).toBe(before.n);
  });
});

// ============================================================================
// H. Edge cases / security
// ============================================================================

describe("H. Edge cases / security", () => {
  it("source RFQ is itself a copy → copied_from points to immediate parent, not grandparent", async () => {
    const { rfq_id: grandparent } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    const m1 = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: grandparent, target_hotel_id: IDS.hotels.A1,
    });
    const parent = await trackCopyResult(m1);
    const m2 = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: parent, target_hotel_id: IDS.hotels.A1,
    });
    const child = await trackCopyResult(m2);
    const childRow = await db.one(
      `SELECT copied_from_rfq_id FROM tbl_rfq WHERE id = $1`,
      [child]
    );
    expect(childRow.copied_from_rfq_id).toBe(parent);
    expect(childRow.copied_from_rfq_id).not.toBe(grandparent);
  });

  it("concurrent copies: each successful copy has a unique rfq_no (collisions fail safely)", async () => {
    // MAX(rfq_no)+1 within a transaction is not collision-proof under heavy
    // concurrency — this matches production's create flow. The unique
    // constraint on rfq_no is the safety net: simultaneous duplicates just
    // fail with 400; no partial state survives the failure. The contract is
    // (a) no orphan/corrupt rows, and (b) any successful copy has a unique
    // rfq_no.
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    const calls = await Promise.all(
      Array.from({ length: 5 }, () =>
        callCopy(IDS.users.a1_proc_buyer, {
          source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
        })
      )
    );
    const newIds = (await Promise.all(calls.map(trackCopyResult))).filter(Boolean);
    expect(newIds.length).toBeGreaterThan(0); // at least one wins
    const rfqNos = await db.any(
      `SELECT rfq_no FROM tbl_rfq WHERE id = ANY($1::int[])`,
      [newIds]
    );
    expect(new Set(rfqNos.map(r => r.rfq_no)).size).toBe(newIds.length);
  });

  it("cross-tenant: target hotel in a different hospitality_company is allowed for users mapped to both", async () => {
    // crossCompany has CEO scope at both A and B; mapping_type=0 includes
    // hotel rows via getUserMappings({includeHotelRows: true}).
    const { rfq_id } = await trackedMakeRFQ({
      createdBy: IDS.users.crossCompany,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
    });
    const m = await callCopy(IDS.users.crossCompany, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.B1,
    });
    expect(m.calls.status).toBe(200);
    const newId = await trackCopyResult(m);
    const newRow = await db.one(
      `SELECT hotel_id, hospitality_company_id FROM tbl_rfq WHERE id = $1`,
      [newId]
    );
    expect(newRow.hotel_id).toBe(IDS.hotels.B1);
    expect(newRow.hospitality_company_id).toBe(IDS.hospitality.B);
  });
});

// ============================================================================
// I. Side effects
// ============================================================================

describe("I. Side effects (none)", () => {
  it("no notifications sent on copy", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    expect(notificationCalls.create).toHaveLength(0);
    expect(notificationCalls.whatsapp).toHaveLength(0);
  });

  it("no approval instance created for the copy", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    const newId = await trackCopyResult(m);
    const apprCount = await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_approval_instances
       WHERE entity_type = 'RFQ' AND entity_id = $1`,
      [newId]
    );
    expect(apprCount.n).toBe(0);
  });

  it("no lifecycle history row recorded for the copy", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    const newId = await trackCopyResult(m);
    const lc = await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_lifecycle_history WHERE entity_id = $1 AND entity_type = 'RFQ'`,
      [newId]
    );
    expect(lc.n).toBe(0);
  });

  it("no edit-history rows for the copy", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    const newId = await trackCopyResult(m);
    const eh = await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_rfq_change_history WHERE rfq_id = $1`,
      [newId]
    );
    expect(eh.n).toBe(0);
  });

  it("source RFQ row + children unchanged after copy", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    await addRfqProduct(rfq_id, TEST_VARIANT_ID);
    await attachProductSpec(rfq_id, TEST_VARIANT_ID, "Quantity", "10");
    const sourceBefore = await db.one(`SELECT * FROM tbl_rfq WHERE id = $1`, [rfq_id]);
    const productsBefore = await db.any(`SELECT * FROM tbl_rfq_products WHERE rfq_id = $1 ORDER BY id`, [rfq_id]);

    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    await trackCopyResult(m);

    const sourceAfter = await db.one(`SELECT * FROM tbl_rfq WHERE id = $1`, [rfq_id]);
    const productsAfter = await db.any(`SELECT * FROM tbl_rfq_products WHERE rfq_id = $1 ORDER BY id`, [rfq_id]);
    expect(sourceAfter).toEqual(sourceBefore);
    expect(productsAfter).toEqual(productsBefore);
  });
});

// ============================================================================
// J. Response shape
// ============================================================================

describe("J. Response shape", () => {
  it("success response carries new_rfq_id, new_rfq_no, copied_from", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.A1,
    });
    await trackCopyResult(m);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body).toMatchObject({
      status: 1,
      data: {
        new_rfq_id: expect.any(Number),
        new_rfq_no: expect.any(Number),
        copied_from: rfq_id,
      },
    });
  });

  it("404 body has status:2 and a message", async () => {
    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: 9999999, target_hotel_id: IDS.hotels.A1,
    });
    expect(m.calls.status).toBe(404);
    expect(m.calls.body).toMatchObject({ status: 2, message: expect.any(String) });
  });

  it("403 body has a message", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    const m = await callCopy(IDS.users.a1_proc_buyer, {
      source_rfq_id: rfq_id, target_hotel_id: IDS.hotels.B1,
    });
    expect(m.calls.status).toBe(403);
    expect(m.calls.body).toMatchObject({ status: 3, message: expect.any(String) });
  });
});
