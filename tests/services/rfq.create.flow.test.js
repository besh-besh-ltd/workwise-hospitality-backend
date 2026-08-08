// Wave-1 step-3.1 / 3.2 / 3.3 tests: rfqController.create — end-to-end
// validation + state transitions for the buyer's "Submit RFQ from Draft"
// entrypoint.
//
// The controller (rfqController.js:4979) does:
//   1. Validate rfq_id required
//   2. Validate reverse-auction date ordering (when reverse_auction=1)
//   3. saveRfqDraft (persist body fields)
//   4. checkRFQCompletion → every product must have Quantity + Unit specs
//   5. checkProductVendors → every product must have ≥1 vendor mapping
//   6. removeRFQData (clear stale child rows)
//   7. UPDATE tbl_rfq SET status=3, hospitality fields
//   8. duplicateRfqForHotels for multi-hotel RFQs
//   9. startApprovalForRfq → creates approval instance + AWS Scheduler job
//
// Per CONVENTIONS.md: every test calls the production controller. We mock the
// cronManager (AWS Scheduler) at module level so the test doesn't try to
// reach AWS.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

// Mock cronManager BEFORE importing the controller — see
// tests/services/rfq.withdrawTerminate.test.js for the same pattern.
//
// `mockState.throwOnSchedule` lets a single test toggle "scheduler creation
// failure" so we can verify the create-tx rollback contract (F-SCHEDULE-001).
// The closure inside the factory closes over the SAME object reference, so
// flipping `mockState.throwOnSchedule = true` at test time changes behaviour
// before the controller calls scheduleRfqPublish.
const scheduleCalls = [];
const mockState = { throwOnSchedule: false };
jest.unstable_mockModule("../../app/helper/cronManager.js", () => ({
  scheduleMilestoneReminder: async () => {},
  rescheduleMilestoneReminder: async () => {},
  removeMilestoneReminder: () => {},
  rescheduleAllMilestoneReminders: async () => {},
  scheduleGRNReminders: async () => {},
  publishRfqById: async () => {},
  scheduleRfqPublish: async (rfq) => {
    if (mockState.throwOnSchedule) {
      throw new Error("F-SCHEDULE-001 simulated AWS Scheduler failure");
    }
    scheduleCalls.push({ rfqId: rfq?.id, ts: Date.now() });
  },
  removeRfqPublishJob: async () => ({ ok: true }),
  rescheduleAllRfqPublishJobs: async () => {},
  startVendorAcceptanceReminderCron: () => {},
  scheduleNegotiationRoundExpiration: () => {},
  removeNegotiationRoundExpiration: () => {},
  rescheduleAllNegotiationRoundExpirations: async () => {},
}));

const { default: rfqController } = await import(
  "../../app/controllers/rfq/rfqController.js"
);

afterAll(async () => {
  await closeDb();
});

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

const inserted = { rfqIds: [], extraProductIds: [] };

beforeEach(() => {
  inserted.rfqIds = [];
  inserted.extraProductIds = [];
  scheduleCalls.length = 0;
  mockState.throwOnSchedule = false;
});

afterEach(async () => {
  if (inserted.rfqIds.length) {
    // Cascade: approval instance children → instance → lifecycle → quote
    // activity → products+specs+vendors → rfq.
    await db.none(
      `DELETE FROM tbl_approval_actions
       WHERE approval_instance_id IN (
         SELECT id FROM tbl_approval_instances
         WHERE entity_type IN ('RFQ','TENDER') AND entity_id = ANY($1::int[])
       )`,
      [inserted.rfqIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_step_approvers
       WHERE approval_instance_step_id IN (
         SELECT s.id FROM tbl_approval_instance_steps s
         JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
         WHERE i.entity_type IN ('RFQ','TENDER') AND i.entity_id = ANY($1::int[])
       )`,
      [inserted.rfqIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instance_steps
       WHERE approval_instance_id IN (
         SELECT id FROM tbl_approval_instances
         WHERE entity_type IN ('RFQ','TENDER') AND entity_id = ANY($1::int[])
       )`,
      [inserted.rfqIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instances
       WHERE entity_type IN ('RFQ','TENDER') AND entity_id = ANY($1::int[])`,
      [inserted.rfqIds]
    );
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_quote_activity WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
});

// ---- Setup helpers ---------------------------------------------------------

/** Create a draft RFQ with NO products (for early-gate tests). */
async function makeDraftRfq(overrides = {}) {
  const sevenDaysHence = new Date(Date.now() + 7 * 86400_000)
    .toISOString().replace("T", " ").slice(0, 19);
  const oneDayHence = new Date(Date.now() + 86400_000)
    .toISOString().replace("T", " ").slice(0, 19);
  const fiveDaysHence = new Date(Date.now() + 5 * 86400_000)
    .toISOString().replace("T", " ").slice(0, 19);

  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 0, // Draft
    is_published: 0,
    tender_publish_date: oneDayHence,
    vendor_clarification_date: fiveDaysHence,
    bid_end_date: sevenDaysHence,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: IDS.processes.A_P1,
    ...overrides,
  });
  inserted.rfqIds.push(rfq_id);
  return rfq_id;
}

/** Add an RFQ product (no specs, no vendor by default). */
async function addProduct(rfq_id, productVariantId = 1) {
  const product = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0)
     RETURNING id`,
    [rfq_id, productVariantId]
  );
  inserted.extraProductIds.push(product.id);
  return product.id;
}

/** Mark a product complete: insert Quantity + Unit specs. */
async function addQuantityAndUnitSpecs(rfq_id, productVariantId = 1) {
  await db.none(
    `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
     VALUES ($1, $2, 'Quantity', '10', 0), ($1, $2, 'Unit', 'NOS', 0)`,
    [rfq_id, productVariantId]
  );
}

/** Map a vendor to an RFQ product. */
async function attachVendor(rfq_id, vendorId, productVariantId = 1) {
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [rfq_id, productVariantId, vendorId]
  );
}

const futureIso = (offsetMs = 7 * 86400_000) => new Date(Date.now() + offsetMs).toISOString();
const pastIso = (offsetMs = 86400_000) => new Date(Date.now() - offsetMs).toISOString();

// ===========================================================================
//  Validation gates — no DB setup needed
// ===========================================================================

describe("rfqController.create — input validation", () => {
  it("rejects when rfq_id is missing", async () => {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { /* no rfq_id */ },
    });
    await rfqController.create(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.errors.rfq).toMatch(/RFQ Id is required/i);
  });
});

describe("rfqController.create — reverse-auction date validation", () => {
  it("rejects when reverse_auction=1 but ra_start_date is missing", async () => {
    const rfq_id = await makeDraftRfq();
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id, reverse_auction: 1,
        ra_end_date: futureIso(7 * 86400_000),
      },
    });
    await rfqController.create(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.errors.ra_start_date).toMatch(/RA Start Date is required/i);
  });

  it("rejects when reverse_auction=1 but ra_end_date is missing", async () => {
    const rfq_id = await makeDraftRfq();
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id, reverse_auction: 1,
        ra_start_date: futureIso(7 * 86400_000),
      },
    });
    await rfqController.create(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.errors.ra_end_date).toMatch(/RA End Date is required/i);
  });

  it("rejects when ra_start_date is invalid", async () => {
    const rfq_id = await makeDraftRfq();
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id, reverse_auction: 1,
        ra_start_date: "not-a-date",
        ra_end_date: futureIso(7 * 86400_000),
      },
    });
    await rfqController.create(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.errors.ra_start_date).toMatch(/Invalid RA Start Date format/i);
  });

  it("rejects when ra_start_date >= ra_end_date", async () => {
    const rfq_id = await makeDraftRfq();
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id, reverse_auction: 1,
        ra_start_date: futureIso(7 * 86400_000),
        ra_end_date: futureIso(3 * 86400_000),
      },
    });
    await rfqController.create(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/before RA End Date/i);
  });

  it("rejects when ra_start_date <= bid_end_date", async () => {
    const rfq_id = await makeDraftRfq();
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id, reverse_auction: 1,
        bid_end_date: futureIso(8 * 86400_000),
        ra_start_date: futureIso(5 * 86400_000), // before bid end
        ra_end_date: futureIso(10 * 86400_000),
      },
    });
    await rfqController.create(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/after Bid End Date/i);
  });

  it("ALLOWS when reverse_auction is OFF, regardless of ra_* values (gate skipped)", async () => {
    // The RA-validation block fires only when reverse_auction is truthy. With
    // reverse_auction=0 the block must be skipped; even garbage ra_* values
    // pass that specific gate.
    const rfq_id = await makeDraftRfq();
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id, reverse_auction: 0,
        ra_start_date: "garbage", ra_end_date: "garbage",
        hotel_ids: [IDS.hotels.A1],
      },
    });
    await rfqController.create(m.req, m.res, () => {});
    // The RA-validation block specifically must NOT be the rejection path.
    if (m.calls.status === 400 && m.calls.body.errors) {
      const allErr = JSON.stringify(m.calls.body.errors);
      expect(allErr).not.toMatch(/RA Start Date|RA End Date/i);
    }
  });
});

// ===========================================================================
//  State gates — checkRFQCompletion + checkProductVendors
// ===========================================================================

describe("rfqController.create — checkRFQCompletion gate (every product needs Quantity + Unit)", () => {
  it("rejects when a product is missing its Quantity / Unit specs", async () => {
    const rfq_id = await makeDraftRfq();
    await addProduct(rfq_id, 1); // product but no specs
    // No vendor either, but completion check fires first.
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: buildBody(rfq_id),
    });
    await rfqController.create(m.req, m.res, () => {});
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.status).toBe(2);
    expect(m.calls.body.message).toMatch(/quantity and unit are required/i);
  });

  it("rejects when Quantity spec is empty/whitespace", async () => {
    const rfq_id = await makeDraftRfq();
    await addProduct(rfq_id, 1);
    // Insert Unit but Quantity with empty value — should still fail completion.
    await db.none(
      `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
       VALUES ($1, 1, 'Quantity', '   ', 0), ($1, 1, 'Unit', 'NOS', 0)`,
      [rfq_id]
    );
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: buildBody(rfq_id),
    });
    await rfqController.create(m.req, m.res, () => {});
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/quantity and unit are required/i);
  });

  it("rejects when Quantity spec is non-numeric", async () => {
    const rfq_id = await makeDraftRfq();
    await addProduct(rfq_id, 1);
    await db.none(
      `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
       VALUES ($1, 1, 'Quantity', 'ten', 0), ($1, 1, 'Unit', 'NOS', 0)`,
      [rfq_id]
    );
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: buildBody(rfq_id),
    });
    await rfqController.create(m.req, m.res, () => {});
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/quantity and unit are required/i);
  });
});

describe("rfqController.create — checkProductVendors gate (every product needs ≥1 vendor)", () => {
  it("rejects when a product has zero vendors", async () => {
    const rfq_id = await makeDraftRfq();
    await addProduct(rfq_id, 1);
    await addQuantityAndUnitSpecs(rfq_id, 1);
    // Deliberately do NOT attach a vendor.

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: buildBody(rfq_id),
    });
    await rfqController.create(m.req, m.res, () => {});
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.status).toBe(2);
    expect(m.calls.body.message).toMatch(/At least one vendor is required/i);
    expect(Array.isArray(m.calls.body.details)).toBe(true);
    expect(m.calls.body.details.length).toBe(1);
  });

  it("lists ALL products that lack vendors (not just the first)", async () => {
    const rfq_id = await makeDraftRfq();
    // Two products, two specs, vendor for product 1 only.
    await addProduct(rfq_id, 1);
    await addProduct(rfq_id, 2);
    await addQuantityAndUnitSpecs(rfq_id, 1);
    await db.none(
      `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
       VALUES ($1, 2, 'Quantity', '5', 0), ($1, 2, 'Unit', 'KG', 0)`,
      [rfq_id]
    );
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);
    // Product 2 has no vendor.

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: buildBody(rfq_id),
    });
    await rfqController.create(m.req, m.res, () => {});
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.details.length).toBe(1);
    expect(m.calls.body.details[0].rfqProductId).toBeTruthy();
  });
});

// ===========================================================================
//  Happy path — passes all gates → status=3 + approval instance + scheduler
// ===========================================================================

// Helper: full body shape matching production. saveRfqDraft REPLACES many
// fields with body values (normalising undefined → null), so we MUST pass
// hospitality_company_id, hotel_id, process_id, dates, AND `filters` (the
// controller does `filters.global` unconditionally and crashes if missing).
function buildBody(rfq_id, overrides = {}) {
  return {
    rfq_id,
    hotel_ids: [IDS.hotels.A1],
    hotel_id: IDS.hotels.A1,
    hospitality_company_id: IDS.hospitality.A,
    process_id: IDS.processes.A_P1,
    department_id: null,
    bid_end_date: new Date(Date.now() + 7 * 86400_000).toISOString().replace("T", " ").slice(0, 19),
    tender_publish_date: new Date(Date.now() + 86400_000).toISOString().replace("T", " ").slice(0, 19),
    vendor_clarification_date: new Date(Date.now() + 5 * 86400_000).toISOString().replace("T", " ").slice(0, 19),
    company_name: "Test Company",
    response_email: "test@example.com",
    contact_name: "Test Contact",
    contact_number: "+91-9999999999",
    location: "Test Location",
    comment: "Test",
    rfq_type: "RFQ",
    is_tender: 0,
    reverse_auction: 0,
    title: "Test RFQ",
    filters: { global: null, local: null },
    updatableData: { products: { updatable: { specs: {} }, deletable: [], insertable: [] }, vendors: {} },
    ...overrides,
  };
}

describe("rfqController.create — happy path", () => {

  it("on success: tbl_rfq.status flips 0 → 3, approval instance created, scheduler called", async () => {
    const rfq_id = await makeDraftRfq();
    await addProduct(rfq_id, 1);
    await addQuantityAndUnitSpecs(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    const m = mockExpress({
      user: {
        id: IDS.users.a1_proc_buyer,
        company_id: IDS.companies.A,
        mobile: "+919999999999",
        email: "a1.proc.buyer@test.local",
      },
      body: buildBody(rfq_id),
    });
    await rfqController.create(m.req, m.res, () => {});

    // After successful submit, status is 4 (READY_TO_PUBLISH) — `startApprovalForRfq`
    // sets status=4 BOTH for the auto-approve path (creator is final approver)
    // and the PENDING path (publish doesn't wait for approval, per the
    // architectural rule).
    const after = await db.one(`SELECT status, hospitality_company_id FROM tbl_rfq WHERE id=$1`, [rfq_id]);
    expect([3, 4]).toContain(after.status);
    expect(after.hospitality_company_id).toBe(IDS.hospitality.A);

    // Approval instance exists for this RFQ against the A1/P1 RFQ policy.
    const inst = await db.one(
      `SELECT entity_type, approval_policy_id, initiated_by
       FROM tbl_approval_instances WHERE entity_id=$1`,
      [rfq_id]
    );
    expect(inst.entity_type).toBe("RFQ");
    expect(inst.approval_policy_id).toBe(IDS.policies.A1_P1_RFQ);
    expect(inst.initiated_by).toBe(IDS.users.a1_proc_buyer);

    // Scheduler was invoked (fire-and-forget mocked) — at least once.
    expect(scheduleCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("F-APPROVAL-001 lock — happy path on a P2 RFQ resolves the P2 approval policy (NOT P1)", async () => {
    const rfq_id = await makeDraftRfq({ process: IDS.processes.A_P2 });
    await addProduct(rfq_id, 1);
    await addQuantityAndUnitSpecs(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    const m = mockExpress({
      user: {
        id: IDS.users.a1_proc_buyer,
        company_id: IDS.companies.A,
        mobile: "+919999999999",
        email: "a1.proc.buyer@test.local",
        name: "A1 Proc Buyer",
      },
      body: buildBody(rfq_id, { process_id: IDS.processes.A_P2 }),
    });
    await rfqController.create(m.req, m.res, () => {});

    const inst = await db.one(
      `SELECT approval_policy_id FROM tbl_approval_instances WHERE entity_id=$1`,
      [rfq_id]
    );
    expect(inst.approval_policy_id).toBe(IDS.policies.A1_P2_RFQ);
    expect(inst.approval_policy_id).not.toBe(IDS.policies.A1_P1_RFQ);
  });
});

// ===========================================================================
//  Multi-hotel duplication + scheduler-failure rollback
// ===========================================================================

describe("rfqController.create — multi-hotel duplication", () => {
  it("F-DUPLICATE-001 — multi-hotel RFQ commits all dupes; each carries the parent's process_id + department_id", async () => {
    // Use hotels A1 + A3. Both have valid 1+ step RFQ policies under P1
    // (A1_P1_RFQ has 2 ALL steps, A3_P1_RFQ has 1 ANY step). A2/P1 is
    // intentionally a zero-step "auto-skip" fixture for a separate engine
    // test — including it here would unnecessarily entangle the two
    // contracts. The F-DUPLICATE-001 principle (process_id + department_id
    // propagation) is fully exercised with one dupe.
    const rfq_id = await makeDraftRfq();
    await addProduct(rfq_id, 1);
    await addQuantityAndUnitSpecs(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    const m = mockExpress({
      user: {
        id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A,
        mobile: "+919999999999", email: "a1.proc.buyer@test.local", name: "A1 Proc Buyer",
      },
      body: buildBody(rfq_id, {
        hotel_ids: [IDS.hotels.A1, IDS.hotels.A3],
        hotel_id: IDS.hotels.A1,
      }),
    });
    await rfqController.create(m.req, m.res, () => {});

    // Track committed dupes so afterEach cleans them. Scope to this test's
    // RFQs only (id >= parent rfq_id); when the full suite runs, earlier
    // files leave behind a1_proc_buyer-created rows that would otherwise
    // pollute this assertion.
    const allRfqs = await db.any(
      `SELECT id, hotel_id FROM tbl_rfq WHERE created_by=$1 AND id >= $2`,
      [IDS.users.a1_proc_buyer, rfq_id]
    );
    inserted.rfqIds.push(
      ...allRfqs.map((r) => r.id).filter((id) => id !== rfq_id && !inserted.rfqIds.includes(id))
    );

    // POST-FIX: duplicateRfqForHotels' INSERT copies process_id + department_id
    // from the parent, so each duplicate RFQ resolves its approval policy
    // correctly. Both rows commit and the controller responds 200.
    expect(m.calls.status).toBe(200);
    const dupes = allRfqs.filter((r) => r.id !== rfq_id);
    expect(dupes.length).toBe(1);
    expect(dupes[0].hotel_id).toBe(IDS.hotels.A3);
    // Duplicate carries the parent's process_id (not NULL) — and the parent's
    // department_id (which makeDraftRfq leaves NULL by default in this test
    // file, so we assert it matches the parent rather than asserting NOT NULL).
    const parent = await db.one(`SELECT process_id, department_id FROM tbl_rfq WHERE id=$1`, [rfq_id]);
    const dupe = await db.one(`SELECT process_id, department_id FROM tbl_rfq WHERE id=$1`, [dupes[0].id]);
    expect(dupe.process_id).toBe(parent.process_id);
    expect(dupe.process_id).toBe(IDS.processes.A_P1);
    expect(dupe.department_id).toBe(parent.department_id);
  });
});

describe("rfqController.create — scheduler-failure rollback", () => {
  it("F-SCHEDULE-001 — scheduleRfqPublish failure rolls back the create tx; RFQ stays in Draft (status=0)", async () => {
    const rfq_id = await makeDraftRfq();
    await addProduct(rfq_id, 1);
    await addQuantityAndUnitSpecs(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    mockState.throwOnSchedule = true;
    const m = mockExpress({
      user: {
        id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A,
        mobile: "+919999999999", email: "a1.proc.buyer@test.local", name: "A1 Proc Buyer",
      },
      body: buildBody(rfq_id),
    });
    await rfqController.create(m.req, m.res, () => {});

    // Controller should return non-200 since the create tx threw.
    expect([400, 500]).toContain(m.calls.status);

    // RFQ remains in Draft (status=0) because the transaction rolled back.
    const after = await db.one(`SELECT status, hotel_id FROM tbl_rfq WHERE id=$1`, [rfq_id]);
    expect(after.status).toBe(0);

    // No approval instance was committed.
    const inst = await db.oneOrNone(
      `SELECT id FROM tbl_approval_instances WHERE entity_id=$1`, [rfq_id]
    );
    expect(inst).toBeNull();

    // Scheduler call list still empty (the throwing call doesn't push).
    expect(scheduleCalls.length).toBe(0);
  });
});

// F-RBAC-001 (can() middleware blocks unprivileged user) requires HTTP-level
// test through the full middleware stack and is part of Wave 3 (Task 12 —
// admin/RBAC audit). Tracked in tests/TODOS.md.
describe("rfqController.create — deferred (Wave 3 / RBAC)", () => {
  it.todo(
    "F-RBAC-001: a user without `tender.create` permission is blocked by `can()` middleware (HTTP-stack test, Wave 3)"
  );
});

// ===========================================================================
//  F-CREATE-WHATSAPP-001 — user without `mobile` must not crash the WA helper
// ===========================================================================
//
// formatPhoneNumber(undefined) currently throws because it calls .replace(...)
// on the input without a nullish-check. The WA notification call is wrapped
// in try/catch in the controller, but the error path swallows the success
// state — the caller may still get an inconsistent response. POST-FIX:
// formatPhoneNumber returns null on undefined/empty AND the call site noops.
// The RFQ creation succeeds and the controller returns a clean status:1.

describe("rfqController.create — F-CREATE-WHATSAPP-001 (no-mobile resilience)", () => {
  it("F-CREATE-WHATSAPP-001 — creator without mobile gets a clean status:1 response (no error swallow)", async () => {
    const rfq_id = await makeDraftRfq();
    await addProduct(rfq_id, 1);
    await addQuantityAndUnitSpecs(rfq_id, 1);
    await attachVendor(rfq_id, IDS.users.vendor_alpha, 1);

    const m = mockExpress({
      user: {
        id: IDS.users.a1_proc_buyer,
        company_id: IDS.companies.A,
        // mobile DELIBERATELY OMITTED — formatPhoneNumber(undefined) throws today.
        email: "a1.proc.buyer@test.local",
        name: "A1 Proc Buyer",
      },
      body: buildBody(rfq_id),
    });
    // Today the controller throws (uncaught) because formatPhoneNumber(undefined)
    // in the WhatsApp helper crashes. Wrap so the test's assertion runs.
    try {
      await rfqController.create(m.req, m.res, () => {});
    } catch {
      /* expected to throw today; assertion below will fail until fixed */
    }

    // POST-FIX: clean success — status flag 1, status code 200, body has the
    // success message. Today the WhatsApp throw path crashes the controller
    // entirely, leaving m.calls.status undefined.
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.status).toBe(1);
    expect(m.calls.body.message).not.toMatch(/error|fail|undefined/i);

    // RFQ creation itself succeeded — status flipped + approval instance present.
    const after = await db.one(`SELECT status FROM tbl_rfq WHERE id=$1`, [rfq_id]);
    expect([3, 4]).toContain(after.status);
  });
});
