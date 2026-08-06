// Wave: negotiation-quote AWARD paths — technical-evaluation guard
// ----------------------------------------------------------------------------
// Product-level integration tests over real HTTP (supertest -> buildTestApp)
// against the local Postgres seed, so the full production middleware stack runs
// (passportSignIn -> acl([2,8]) -> requireHospitality -> controller).
//
// THE GAP THESE LOCK SHUT
//   A technical-evaluation guard was added to POST /rfq/finalize. It was
//   bypassable: negotiationController.addQuotesToFinalization writes
//   tbl_quote_finalization for an ARBITRARY-LENGTH LIST of vendors and used to
//   validate nothing beyond the existence of the product row. It is reachable
//   from two routes:
//
//     POST /negotiation/quotes/submit-for-approval        (auto-approve branch)
//     POST /negotiation/quotes/:rfq_product_id/approve    (tender AND non-tender
//                                                          branches; the latter
//                                                          also drafts POs)
//
//   So a buyer blocked at /rfq/finalize could award the exact same
//   technically-failed vendor by routing the award through negotiation instead
//   — and, being multi-vendor, could award several at once.
//
// THE PREDICATE UNDER TEST is the same one /rfq/finalize uses, because both now
// consume services/technicalQualificationService.js rather than each carrying a
// copy of the SQL:
//   Condition 1 (RFQ level)     — no technical evaluation anywhere in the RFQ,
//                                 OR the vendor passed at least one product.
//   Condition 2 (product level) — no technical evaluation on THIS product,
//                                 OR the vendor passed THIS product.
//   status = 1 passes; status = 0 blocks; NO verdict row blocks wherever an
//   evaluation is configured. Both conditions fall through when no evaluation
//   is configured, so an ordinary RFQ stays fully awardable — the regression
//   that matters most, asserted in BOTH describes below.
//
// SEMANTICS ON A MIXED LIST: wholesale refusal, never filter-and-continue.
// These lists are approved as a unit and the ARC instance is built from
// selected_quotes[0]; quietly awarding the survivors would leave an approval
// record that no longer describes what happened, with no way for the buyer to
// find out. Tests below assert the QUALIFIED vendor in a mixed list is ALSO not
// awarded.
//
// Every assertion reads tbl_quote_finalization back, because a 400 that still
// wrote the award row would be worse than no guard at all.

import {
  describe, it, expect, afterAll, beforeAll, beforeEach, afterEach,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { createApprovalInstance } from "../../app/models/generalModel.js";

let VARIANT_A = 1;
let RFQ_NO_COUNTER = 8_930_000;
const nextRfqNo = () => ++RFQ_NO_COUNTER;

// Both routes are gated by acl([2, 8]), which reads tbl_users.user_type — and
// the shared fixture users deliberately leave user_type NULL
// (tests/fixtures/users.js), so every request would 403 before reaching the
// controller. Buyers are user_type 2 in production; set it for the duration of
// this suite and put it back afterwards so suites sharing this database are
// unaffected. Same pattern as
// approvalPropagation.rolePermissionRevocation.test.js:256.
const BUYER = IDS.users.a1_proc_buyer;      // submits quotes for approval
const APPROVER = IDS.users.a1_proc_commApp; // the A1/P1 NEGOTIATION_QUOTE approver

// Vendor labels the guard composes from tbl_company.company_name (NOT the dead
// tbl_users.organization_name) — the message has to name WHICH vendor was
// refused, and the ID disambiguates same-named vendors.
const ALPHA_LABEL = "Alpha Vendor Pvt Ltd";
const BETA_LABEL = "Beta Vendor Pvt Ltd";

beforeAll(async () => {
  const v = await db.oneOrNone(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 1`);
  if (v) VARIANT_A = v.id;
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [[BUYER, APPROVER]]);
});

afterAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = ANY($1::int[])`, [[BUYER, APPROVER]]);
  await closeDb();
});

const inserted = {
  rfqIds: [],
  rfqProductIds: [],
  quoteIds: [],
  techEvalIds: [],
  approvalInstanceIds: [],
};

beforeEach(() => {
  inserted.rfqIds = [];
  inserted.rfqProductIds = [];
  inserted.quoteIds = [];
  inserted.techEvalIds = [];
  inserted.approvalInstanceIds = [];
});

afterEach(async () => {
  // Sweep up anything the controller opened against our rfq_products as well as
  // what the test staged, so a half-run test cannot leak rows into the next.
  const instanceIds = new Set(inserted.approvalInstanceIds);
  if (inserted.rfqProductIds.length) {
    const rows = await db.any(
      `SELECT id FROM tbl_approval_instances
        WHERE entity_type IN ('NEGOTIATION_QUOTE', 'ARC') AND entity_id = ANY($1::int[])`,
      [inserted.rfqProductIds]
    );
    for (const r of rows) instanceIds.add(r.id);
  }
  const ids = [...instanceIds];
  if (ids.length) {
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [ids]);
    await db.none(
      `DELETE FROM tbl_approval_step_approvers
        WHERE approval_instance_step_id IN
          (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [ids]
    );
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [ids]);
  }
  if (inserted.techEvalIds.length) {
    await db.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation_cleared_vendors
        WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[])`,
      [inserted.techEvalIds]
    );
    await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation WHERE id = ANY($1::int[])`, [inserted.techEvalIds]);
  }
  if (inserted.rfqIds.length) {
    // The non-tender approve branch drafts POs, so those come out first.
    await db.none(
      `DELETE FROM tbl_purchase_order_product
        WHERE purchase_order_id IN (SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = ANY($1::int[]))`,
      [inserted.rfqIds]
    );
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_quote_finalization_history WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
});

// ---- Setup helpers ---------------------------------------------------------

// "YYYY-MM-DD HH:mm:ss" — the shape bid_end_date is stored in (naive IST
// wall-clock; see CLAUDE.md "Timezone").
const tsString = (offsetMs) =>
  new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);

// A published, non-tender hospitality RFQ on the seeded A1/P1 path, so the
// NEGOTIATION_QUOTE approval policy resolves to a1_proc_commApp and the staged
// instance lands PENDING rather than auto-approving.
async function makeAwardableRfq() {
  const rfq = await db.one(
    `INSERT INTO tbl_rfq
       (rfq_no, comment, company_name, response_email, contact_name, contact_number,
        bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
        hospitality_company_id, hotel_id, process_id, is_tender, title)
     VALUES ($1, '<p>e2e</p>', '', 'b@a', 'A1', '+91', $2, 'Mumbai', 1, 1, $3, $3,
             (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'), $4, $5, $6, 0,
             'negotiation award tech-guard fixture')
     RETURNING id, rfq_no`,
    [nextRfqNo(), tsString(-3600_000), BUYER, IDS.hospitality.A, IDS.hotels.A1, IDS.processes.A_P1]
  );
  inserted.rfqIds.push(rfq.id);

  const prod = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
    [rfq.id, VARIANT_A]
  );
  inserted.rfqProductIds.push(prod.id);

  return { rfq_id: rfq.id, rfq_no: rfq.rfq_no, rfq_product_id: prod.id };
}

// Seed a vendor's quote for the product. Returns BOTH ids: submit-for-approval
// with quote_source 'regular' keys on tbl_quotes.id, while the approval
// metadata and PO drafting key on the quote item.
async function plantQuote(rfq_id, rfq_no, vendorId, unitPrice) {
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING`,
    [rfq_id, VARIANT_A, vendorId]
  );
  const q = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
     VALUES ($1, $2, $3, $3, 1, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')) RETURNING id`,
    [rfq_id, rfq_no, vendorId]
  );
  inserted.quoteIds.push(q.id);
  const qi = await db.one(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, package_price,
        tax, freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
     VALUES ($1, $2, $3, $4, $5, $6, 0, 18, 0, 0, 'q', '15', '100', 'percentage', '[]')
     RETURNING id`,
    [rfq_id, rfq_no, q.id, VARIANT_A, unitPrice, unitPrice * 100]
  );
  return { quoteId: q.id, quoteItemId: qi.id };
}

// Configure technical evaluation for one product and seed per-vendor verdicts.
// verdicts: [{ vendorId, status, score }] — status 1 = passed, 0 = failed.
// Omit a vendor to leave them with NO verdict row (the TECH_PENDING state).
// Presence of the te row is what makes the product "configured".
async function seedProductTech(rfq_id, rfq_product_id, verdicts = [], minScore = 50) {
  const te = await db.one(
    `INSERT INTO tbl_rfq_product_tech_evaluation
       (rfq_id, tbl_rfq_product_id, minimum_passing_score, "timestamp")
     VALUES ($1, $2, $3, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')) RETURNING id`,
    [rfq_id, rfq_product_id, minScore]
  );
  inserted.techEvalIds.push(te.id);
  for (const v of verdicts) {
    await db.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation_cleared_vendors
         (tbl_rfq_product_tech_evaluation_id, vendor_id, status, calculated_score,
          is_verified, created_by, "timestamp")
       VALUES ($1, $2, $3, $4, true, $5, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'))`,
      [te.id, v.vendorId, v.status, v.score ?? null, BUYER]
    );
  }
  return te.id;
}

// Stage the PENDING NEGOTIATION_QUOTE approval that submitQuotesForApproval
// would have created, so the approve route can be exercised on its own.
async function stagePendingApproval(rfq_id, rfq_no, rfq_product_id, selected) {
  const result = await createApprovalInstance({
    entity_type: "NEGOTIATION_QUOTE",
    entity_id: rfq_product_id,
    hospitality_company_id: IDS.hospitality.A,
    hotel_id: IDS.hotels.A1,
    department_id: null,
    process_id: IDS.processes.A_P1,
    initiated_by: BUYER,
    metadata: {
      rfq_id,
      rfq_number: rfq_no,
      rfq_product_id,
      is_tender: 0,
      selected_quotes: selected.map((s) => ({
        quote_id: s.quoteItemId,
        vendor_id: s.vendorId,
        quoted_price: s.price,
      })),
    },
  });
  inserted.approvalInstanceIds.push(result.instance.id);
  // The A1/P1 policy requires a1_proc_commApp, and BUYER is not them — so this
  // must park in PENDING. If it ever auto-approves, the approve-route tests
  // below would be testing nothing.
  expect(result.autoApproved).toBeFalsy();
  expect(result.instance.status).toBe("PENDING");
  return result.instance.id;
}

async function finalizationRow(rfq_id, vendorId) {
  return db.oneOrNone(
    `SELECT id FROM tbl_quote_finalization
      WHERE rfq_id = $1 AND product_variant_id = $2 AND variant = 0 AND vendor_id = $3`,
    [rfq_id, VARIANT_A, vendorId]
  );
}

async function instanceStatus(instanceId) {
  const row = await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [instanceId]);
  return row.status;
}

// ============================================================================

describe("POST /negotiation/quotes/submit-for-approval — technical-evaluation guard", () => {
  it("REFUSES a technically failed vendor, writes no award row, and opens no approval", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeAwardableRfq();
    const failed = IDS.users.vendor_alpha;
    const { quoteId } = await plantQuote(rfq_id, rfq_no, failed, 500);
    await seedProductTech(rfq_id, rfq_product_id, [{ vendorId: failed, status: 0, score: 20 }], 50);

    const client = await httpClient(BUYER);
    const res = await client.post("/api/v1/negotiation/quotes/submit-for-approval").send({
      rfq_id,
      rfq_product_id,
      quote_ids: [quoteId],
      quote_source: "regular",
    });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe(2);
    // The refusal must name WHICH vendor and WHY — the FE surfaces this string.
    expect(res.body.message).toContain(ALPHA_LABEL);
    expect(res.body.message).toContain(`ID ${failed}`);
    expect(res.body.message).toMatch(/failed the technical evaluation/i);
    expect(res.body.message).toContain("scored 20");
    expect(res.body.message).toContain("minimum of 50");

    // No award, and no approval left sitting in front of an approver either.
    expect(await finalizationRow(rfq_id, failed)).toBeNull();
    const opened = await db.oneOrNone(
      `SELECT id FROM tbl_approval_instances
        WHERE entity_type = 'NEGOTIATION_QUOTE' AND entity_id = $1`,
      [rfq_product_id]
    );
    expect(opened).toBeNull();
  });

  it("REFUSES a vendor with no technical verdict yet, naming incompleteness rather than failure", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeAwardableRfq();
    const unjudged = IDS.users.vendor_beta;
    const { quoteId } = await plantQuote(rfq_id, rfq_no, unjudged, 480);
    // Evaluation configured; a DIFFERENT vendor judged, this one has no row.
    await seedProductTech(rfq_id, rfq_product_id, [{ vendorId: IDS.users.vendor_alpha, status: 1, score: 80 }], 50);

    const client = await httpClient(BUYER);
    const res = await client.post("/api/v1/negotiation/quotes/submit-for-approval").send({
      rfq_id,
      rfq_product_id,
      quote_ids: [quoteId],
      quote_source: "regular",
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain(BETA_LABEL);
    expect(res.body.message).toMatch(/not been completed/i);
    // Must NOT accuse an unjudged vendor of failing — different buyer action.
    expect(res.body.message).not.toMatch(/failed the technical evaluation/i);
    expect(await finalizationRow(rfq_id, unjudged)).toBeNull();
  });

  // WHOLESALE, NOT FILTER-AND-CONTINUE. The decisive assertion is the second
  // one: the QUALIFIED vendor must not be awarded either. Filtering would have
  // silently awarded alpha while the approver believed they were approving
  // alpha AND beta.
  it("REFUSES the WHOLE request when the vendor list mixes qualified and disqualified, awarding neither", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeAwardableRfq();
    const passed = IDS.users.vendor_alpha;
    const failed = IDS.users.vendor_beta;
    const a = await plantQuote(rfq_id, rfq_no, passed, 500);
    const b = await plantQuote(rfq_id, rfq_no, failed, 450);
    await seedProductTech(
      rfq_id,
      rfq_product_id,
      [{ vendorId: passed, status: 1, score: 80 }, { vendorId: failed, status: 0, score: 30 }],
      50
    );

    const client = await httpClient(BUYER);
    const res = await client.post("/api/v1/negotiation/quotes/submit-for-approval").send({
      rfq_id,
      rfq_product_id,
      quote_ids: [a.quoteId, b.quoteId],
      quote_source: "regular",
    });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe(2);
    // Names the offender...
    expect(res.body.message).toContain(BETA_LABEL);
    expect(res.body.message).toContain(`ID ${failed}`);
    // ...and never smears the vendor who passed.
    expect(res.body.message).not.toContain(ALPHA_LABEL);
    // ...and says plainly that nothing was awarded, so the buyer knows the
    // qualified vendor still needs resubmitting.
    expect(res.body.message).toMatch(/no vendor was finalized/i);

    expect(await finalizationRow(rfq_id, failed)).toBeNull();
    expect(await finalizationRow(rfq_id, passed)).toBeNull(); // <-- the wholesale contract
  });

  it("ACCEPTS a fully qualified multi-vendor list", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeAwardableRfq();
    const a = await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, 500);
    const b = await plantQuote(rfq_id, rfq_no, IDS.users.vendor_beta, 450);
    await seedProductTech(
      rfq_id,
      rfq_product_id,
      [
        { vendorId: IDS.users.vendor_alpha, status: 1, score: 80 },
        { vendorId: IDS.users.vendor_beta, status: 1, score: 70 },
      ],
      50
    );

    const client = await httpClient(BUYER);
    const res = await client.post("/api/v1/negotiation/quotes/submit-for-approval").send({
      rfq_id,
      rfq_product_id,
      quote_ids: [a.quoteId, b.quoteId],
      quote_source: "regular",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(JSON.stringify(res.body)).not.toMatch(/technical/i);
  });

  // THE REGRESSION THAT MATTERS MOST. The overwhelmingly common RFQ has no
  // technical evaluation at all; breaking it would be far worse than the hole
  // being closed. Both guard conditions must fall through on NOT EXISTS.
  it("ACCEPTS an RFQ with NO technical evaluation configured at all", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeAwardableRfq();
    const { quoteId } = await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, 500);
    // Deliberately NO seedProductTech.
    const techRows = await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = $1`,
      [rfq_id]
    );
    expect(techRows.n).toBe(0); // fixture precondition, not the assertion

    const client = await httpClient(BUYER);
    const res = await client.post("/api/v1/negotiation/quotes/submit-for-approval").send({
      rfq_id,
      rfq_product_id,
      quote_ids: [quoteId],
      quote_source: "regular",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
  });
});

// ============================================================================
// The approve route is the one that actually WRITES the award (and, on the
// non-tender branch, drafts the PO). It is also where ORDERING matters:
// submitApprovalAction commits the approval BEFORE addQuotesToFinalization
// runs, so a guard that fired only at the write would leave the instance
// APPROVED with nothing awarded. Every refusal below therefore asserts the
// instance is still PENDING.
// ============================================================================
describe("POST /negotiation/quotes/:rfq_product_id/approve — technical-evaluation guard", () => {
  it("REFUSES a technically failed vendor, writes no award row, and leaves the approval PENDING", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeAwardableRfq();
    const failed = IDS.users.vendor_alpha;
    const { quoteItemId } = await plantQuote(rfq_id, rfq_no, failed, 500);
    await seedProductTech(rfq_id, rfq_product_id, [{ vendorId: failed, status: 0, score: 20 }], 50);
    const instanceId = await stagePendingApproval(rfq_id, rfq_no, rfq_product_id, [
      { vendorId: failed, quoteItemId, price: 500 },
    ]);

    const client = await httpClient(APPROVER);
    const res = await client
      .post(`/api/v1/negotiation/quotes/${rfq_product_id}/approve`)
      .send({ remarks: "approving" });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe(2);
    expect(res.body.message).toContain(ALPHA_LABEL);
    expect(res.body.message).toMatch(/failed the technical evaluation/i);

    expect(await finalizationRow(rfq_id, failed)).toBeNull();
    // The approval must not have been half-applied: an APPROVED instance with
    // no award is a state no screen can explain and no action can clear.
    expect(await instanceStatus(instanceId)).toBe("PENDING");
    // ...and no PO was drafted for them either.
    const po = await db.oneOrNone(`SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = $1`, [rfq_id]);
    expect(po).toBeNull();
  });

  it("AWARDS a technically passed vendor", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeAwardableRfq();
    const passed = IDS.users.vendor_alpha;
    const { quoteItemId } = await plantQuote(rfq_id, rfq_no, passed, 500);
    await seedProductTech(rfq_id, rfq_product_id, [{ vendorId: passed, status: 1, score: 80 }], 50);
    const instanceId = await stagePendingApproval(rfq_id, rfq_no, rfq_product_id, [
      { vendorId: passed, quoteItemId, price: 500 },
    ]);

    const client = await httpClient(APPROVER);
    const res = await client
      .post(`/api/v1/negotiation/quotes/${rfq_product_id}/approve`)
      .send({ remarks: "approving" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(await instanceStatus(instanceId)).toBe("APPROVED");
    expect(await finalizationRow(rfq_id, passed)).not.toBeNull();

    // REGRESSION: this branch used to select a phantom `qi.unit`, which does not
    // exist on tbl_quote_items. The 42703 was swallowed by the per-vendor
    // catch, but it had already aborted the POSTGRES transaction, so the COMMIT
    // degraded to a ROLLBACK and the award inserted moments earlier vanished —
    // while the endpoint answered 200 "Quotes fully approved and finalized".
    // The finalization assertion above is what actually failed; this one pins
    // the downstream half of the same transaction so the phantom column cannot
    // creep back in unnoticed.
    const po = await db.oneOrNone(`SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = $1`, [rfq_id]);
    expect(po).not.toBeNull();
  });

  // Same regression as above, on the write path that actually inserts.
  it("AWARDS on an RFQ with NO technical evaluation configured at all", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeAwardableRfq();
    const vendor = IDS.users.vendor_alpha;
    const { quoteItemId } = await plantQuote(rfq_id, rfq_no, vendor, 500);
    // Deliberately NO seedProductTech.
    const techRows = await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = $1`,
      [rfq_id]
    );
    expect(techRows.n).toBe(0); // fixture precondition, not the assertion

    const instanceId = await stagePendingApproval(rfq_id, rfq_no, rfq_product_id, [
      { vendorId: vendor, quoteItemId, price: 500 },
    ]);

    const client = await httpClient(APPROVER);
    const res = await client
      .post(`/api/v1/negotiation/quotes/${rfq_product_id}/approve`)
      .send({ remarks: "approving" });

    expect(res.status).toBe(200);
    expect(await instanceStatus(instanceId)).toBe("APPROVED");
    expect(await finalizationRow(rfq_id, vendor)).not.toBeNull();
  });

  it("REFUSES the WHOLE approval when the awarded list mixes qualified and disqualified, awarding neither", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeAwardableRfq();
    const passed = IDS.users.vendor_alpha;
    const failed = IDS.users.vendor_beta;
    const a = await plantQuote(rfq_id, rfq_no, passed, 500);
    const b = await plantQuote(rfq_id, rfq_no, failed, 450);
    await seedProductTech(
      rfq_id,
      rfq_product_id,
      [{ vendorId: passed, status: 1, score: 80 }, { vendorId: failed, status: 0, score: 30 }],
      50
    );
    const instanceId = await stagePendingApproval(rfq_id, rfq_no, rfq_product_id, [
      { vendorId: passed, quoteItemId: a.quoteItemId, price: 500 },
      { vendorId: failed, quoteItemId: b.quoteItemId, price: 450 },
    ]);

    const client = await httpClient(APPROVER);
    const res = await client
      .post(`/api/v1/negotiation/quotes/${rfq_product_id}/approve`)
      .send({ remarks: "approving" });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain(BETA_LABEL);
    expect(res.body.message).not.toContain(ALPHA_LABEL);

    expect(await finalizationRow(rfq_id, failed)).toBeNull();
    expect(await finalizationRow(rfq_id, passed)).toBeNull(); // <-- the wholesale contract
    expect(await instanceStatus(instanceId)).toBe("PENDING");
  });

  // A vendor can clear technical evaluation at submit time and be failed before
  // the approver acts (evaluation reopened, verdict corrected). The verdict that
  // binds is the one standing at the moment of AWARD, which is why the approve
  // route re-checks instead of trusting the submit-time screen.
  it("REFUSES a vendor whose verdict flipped to failed AFTER the quotes were submitted for approval", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeAwardableRfq();
    const vendor = IDS.users.vendor_alpha;
    const { quoteItemId } = await plantQuote(rfq_id, rfq_no, vendor, 500);
    const teId = await seedProductTech(rfq_id, rfq_product_id, [{ vendorId: vendor, status: 1, score: 80 }], 50);
    const instanceId = await stagePendingApproval(rfq_id, rfq_no, rfq_product_id, [
      { vendorId: vendor, quoteItemId, price: 500 },
    ]);

    // ...evaluation is revisited and this vendor is failed.
    await db.none(
      `UPDATE tbl_rfq_product_tech_evaluation_cleared_vendors
          SET status = 0, calculated_score = 25
        WHERE tbl_rfq_product_tech_evaluation_id = $1 AND vendor_id = $2`,
      [teId, vendor]
    );

    const client = await httpClient(APPROVER);
    const res = await client
      .post(`/api/v1/negotiation/quotes/${rfq_product_id}/approve`)
      .send({ remarks: "approving" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/failed the technical evaluation/i);
    expect(await finalizationRow(rfq_id, vendor)).toBeNull();
    expect(await instanceStatus(instanceId)).toBe("PENDING");
  });
});
