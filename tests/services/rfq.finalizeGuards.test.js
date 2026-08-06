// Wave: POST /api/v1/rfq/finalize — technical-evaluation guard on the AWARD
// ----------------------------------------------------------------------------
// Product-level integration tests over real HTTP (supertest -> buildTestApp)
// against the local Postgres seed, so the full production middleware stack runs
// (passportSignIn -> user_id_profileexists -> acl([2,8,10]) -> Joi finalize
// schema -> rfqController.finalize).
//
// THE GAP THESE LOCK SHUT
//   A vendor who quotes but FAILS technical evaluation is correctly hidden from
//   the buyer's comparison screen — but that suppression was enforced ENTIRELY
//   at the read layer. rfqModel.getQuotesByRfqById2 is called with
//   TA_Vendors='TA', appending `vendorCondition` (rfqModel.js L6527 / L6911) to
//   drop the disqualified vendor's quotation rows; quoteCompareViewModel then
//   emits a null cell plus a TECH_FAILED / TECH_PENDING absence reason, and the
//   FE renders the cell unselectable.
//
//   rfqController.finalize itself performed NO technical check. A crafted or
//   replayed POST /rfq/finalize therefore awarded a real contract to a vendor
//   the buyer's own technical gate had failed, with nothing server-side
//   stopping it. Observed shape: RFQ 363 / rfq_product 704, vendor 429 scored 20
//   against a minimum of 50 and sat at status = 0 in
//   tbl_rfq_product_tech_evaluation_cleared_vendors.
//
// THE PREDICATE UNDER TEST (mirrors `vendorCondition` exactly)
//   Condition 1 (RFQ level)     — no technical evaluation anywhere in the RFQ,
//                                 OR the vendor passed at least one product.
//   Condition 2 (product level) — no technical evaluation on THIS product,
//                                 OR the vendor passed THIS product.
//   status = 1 passes; status = 0 blocks; NO verdict row blocks wherever an
//   evaluation is configured (nobody has judged the vendor, so there is no
//   clearance to award on). Both conditions fall through when no evaluation is
//   configured, so a plain RFQ stays fully finalizable — that regression is the
//   one that matters most and is asserted below.
//
// Every assertion reads tbl_quote_finalization back, because a 400 that still
// wrote the award row would be worse than no guard at all.

import {
  describe, it, expect, afterAll, beforeAll, beforeEach, afterEach,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";

// A real product_variant id from the staging snapshot, so the controller's
// getRfqById product joins resolve (finalize requires a matching product).
let VARIANT_A = 1;

// The route is gated by acl([2, 8, 10]), which reads tbl_users.user_type — and
// the shared fixture users deliberately leave user_type NULL (tests/fixtures/
// users.js), so every request would 403 before reaching the controller. Buyers
// are user_type 2 in production; set it for the duration of this suite and put
// it back afterwards so suites sharing this database are unaffected. Same
// pattern as approvalPropagation.rolePermissionRevocation.test.js:256.
const BUYER = IDS.users.a1_proc_buyer;

beforeAll(async () => {
  const v = await db.oneOrNone(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 1`);
  if (v) VARIANT_A = v.id;
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
});

afterAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [BUYER]);
  await closeDb();
});

const inserted = {
  rfqIds: [],
  rfqProductIds: [],
  quoteIds: [],
  techEvalIds: [],
  hierarchyIds: [],
  approvalInstanceIds: [],
  roundIds: [],
};

beforeEach(() => {
  inserted.rfqIds = [];
  inserted.rfqProductIds = [];
  inserted.quoteIds = [];
  inserted.techEvalIds = [];
  inserted.hierarchyIds = [];
  inserted.approvalInstanceIds = [];
  inserted.roundIds = [];
});

afterEach(async () => {
  // Approval instances created by the success paths (NEGOTIATION_QUOTE), plus
  // anything the controller opened against our rfq_products.
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
  if (inserted.hierarchyIds.length) {
    await db.none(`DELETE FROM tbl_approval_hierarchy WHERE id = ANY($1::int[])`, [inserted.hierarchyIds]);
  }
  if (inserted.roundIds.length) {
    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [inserted.roundIds]);
  }
  if (inserted.rfqIds.length) {
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

// "YYYY-MM-DD HH:mm:ss", the shape bid_end_date is stored in (naive IST
// wall-clock — see CLAUDE.md "Timezone").
const tsString = (offsetMs) =>
  new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);

// A published RFQ past its bid deadline (quotes unlocked), on the seeded
// A1/P1 path so the NEGOTIATION_QUOTE approval policy resolves on the
// success paths and the award parks in PENDING rather than drafting a PO.
async function makeFinalizableRfq() {
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    is_tender: 0,
    tender_publish_date: tsString(-2 * 86400_000),
    vendor_clarification_date: tsString(-86400_000),
    bid_end_date: tsString(-3600_000),
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
    title: "finalize tech-guard fixture",
  });
  inserted.rfqIds.push(rfq_id);

  const prod = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
    [rfq_id, VARIANT_A]
  );
  inserted.rfqProductIds.push(prod.id);

  return { rfq_id, rfq_no, rfq_product_id: prod.id };
}

// Seed a vendor's quote line for the product. Returns the quote_item id, which
// finalize carries as both quote_id and quote_item_id from the FE.
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
  return qi.id;
}

// Configure technical evaluation for one product and seed per-vendor verdicts.
// verdicts: [{ vendorId, status, score }] — status 1 = passed, 0 = failed.
// Omit a vendor entirely to leave them with NO verdict row (the TECH_PENDING
// third state). Presence of the te row is what makes the product "configured".
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
      [te.id, v.vendorId, v.status, v.score ?? null, IDS.users.a1_proc_buyer]
    );
  }
  return te.id;
}

// finalize walks tbl_approval_hierarchy: a row at approval_level = -1 marks the
// user a FINAL APPROVER and is rejected; otherwise the user must be a member,
// unless the company has no hierarchy at all. Seed an ordinary membership row
// so the success paths are deterministic either way.
async function seedPoHierarchy(userId = BUYER) {
  const { company_id } = await db.one(`SELECT company_id FROM tbl_users WHERE id = $1`, [userId]);
  const row = await db.one(
    `INSERT INTO tbl_approval_hierarchy (company_id, user_id, approval_level, bypass_cap, hierarchy_type)
     VALUES ($1, $2, 1, 0, 'po') RETURNING id`,
    [company_id, userId]
  );
  inserted.hierarchyIds.push(row.id);
  return row.id;
}

// Insert a negotiation round directly, in either persistence shape.
//
//   shape 'legacy' — one product, carried on the rfq_product_id COLUMN
//                    (products NULL). What negotiationController writes when a
//                    round covers exactly one product and nothing RFQ-level.
//   shape 'multi'  — rfq_product_id NULL, coverage in the `products` JSONB.
//                    What it writes for multi-product or RFQ-level rounds
//                    (negotiationController.js L979-1001, `isMultiShape`).
//
// endsInHoursUtc is added to `now() AT TIME ZONE 'UTC'`, NOT to session-TZ
// now(): end_date is a naive column holding UTC wall clock, so the fixture has
// to be anchored the same way the guard reads it. Anchoring to NOW() would
// silently shift the fixture by the session offset on a non-UTC machine.
async function plantRound(
  rfq_id,
  { shape, coveredProductIds = [], rfqLevel = false, status = "ACTIVE", endsInHoursUtc = 24 }
) {
  const products = shape === "multi"
    ? JSON.stringify([
        ...coveredProductIds.map((pid) => ({ rfq_product_id: pid, vendor_targets: [] })),
        ...(rfqLevel ? [{ is_rfq_level: true, vendor_targets: [] }] : []),
      ])
    : null;
  const legacyColumn = shape === "legacy" ? coveredProductIds[0] : null;

  const row = await db.one(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, rfq_product_id, round_number, end_date, status, created_by,
        source_type, source_id, vendor_ids, vendor_approvals, products, created_at)
     VALUES ($1, $2, 1,
             (now() AT TIME ZONE 'UTC') + ($3 || ' hours')::interval,
             $4, $5, 'RFQ', $1, ARRAY[$6]::int[], '[]'::jsonb, $7::jsonb,
             (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'))
     RETURNING id`,
    [rfq_id, legacyColumn, String(endsInHoursUtc), status, BUYER, IDS.users.vendor_alpha, products]
  );
  inserted.roundIds.push(row.id);
  return row.id;
}

function finalizeBody({ rfq_id, rfq_no, vendorId, quoteItemId }) {
  return {
    rfq_id,
    rfq_no,
    product_variant_id: VARIANT_A,
    variant: 0,
    vendor_id: vendorId,
    quote_id: quoteItemId,
    quote_item_id: quoteItemId,
    route_type: "PO",
    comment: "awarding this vendor after evaluation",
  };
}

async function finalizationRow(rfq_id, vendorId) {
  return db.oneOrNone(
    `SELECT id FROM tbl_quote_finalization
      WHERE rfq_id = $1 AND product_variant_id = $2 AND variant = 0 AND vendor_id = $3`,
    [rfq_id, VARIANT_A, vendorId]
  );
}

// ============================================================================

describe("POST /rfq/finalize — technical-evaluation guard", () => {
  it("REFUSES a vendor who failed technical evaluation for the product, and writes no award row", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeFinalizableRfq();
    const failedVendor = IDS.users.vendor_alpha;
    const quoteItemId = await plantQuote(rfq_id, rfq_no, failedVendor, 500);
    // Mirrors the observed case: scored 20 against a minimum of 50 => status 0.
    await seedProductTech(rfq_id, rfq_product_id, [{ vendorId: failedVendor, status: 0, score: 20 }], 50);
    await seedPoHierarchy();

    const client = await httpClient(BUYER);
    const res = await client
      .post("/api/v1/rfq/finalize")
      .send(finalizeBody({ rfq_id, rfq_no, vendorId: failedVendor, quoteItemId }));

    expect(res.status).toBe(400);
    expect(res.body.status).toBe(2);
    // The message must name the reason — the buyer reads this string.
    expect(res.body.message).toMatch(/failed the technical evaluation/i);
    expect(res.body.message).toMatch(/cannot be finalized/i);
    // ...and carry the score context the buyer needs to act on it.
    expect(res.body.message).toContain("scored 20");
    expect(res.body.message).toContain("minimum of 50");

    // The award must not exist. A 400 that still inserted would be the worst case.
    expect(await finalizationRow(rfq_id, failedVendor)).toBeNull();
  });

  it("REFUSES a vendor with no technical verdict yet, naming incompleteness rather than failure", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeFinalizableRfq();
    const unjudged = IDS.users.vendor_beta;
    const quoteItemId = await plantQuote(rfq_id, rfq_no, unjudged, 480);
    // Evaluation configured, a DIFFERENT vendor judged, this one has no row.
    await seedProductTech(rfq_id, rfq_product_id, [{ vendorId: IDS.users.vendor_alpha, status: 1, score: 80 }], 50);
    await seedPoHierarchy();

    const client = await httpClient(BUYER);
    const res = await client
      .post("/api/v1/rfq/finalize")
      .send(finalizeBody({ rfq_id, rfq_no, vendorId: unjudged, quoteItemId }));

    expect(res.status).toBe(400);
    expect(res.body.status).toBe(2);
    expect(res.body.message).toMatch(/not been completed/i);
    // Must NOT accuse an unjudged vendor of failing — different buyer action.
    expect(res.body.message).not.toMatch(/failed/i);

    expect(await finalizationRow(rfq_id, unjudged)).toBeNull();
  });

  it("ALLOWS a vendor who passed technical evaluation for the product", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeFinalizableRfq();
    const passedVendor = IDS.users.vendor_alpha;
    const quoteItemId = await plantQuote(rfq_id, rfq_no, passedVendor, 500);
    await seedProductTech(rfq_id, rfq_product_id, [{ vendorId: passedVendor, status: 1, score: 80 }], 50);
    await seedPoHierarchy();

    const client = await httpClient(BUYER);
    const res = await client
      .post("/api/v1/rfq/finalize")
      .send(finalizeBody({ rfq_id, rfq_no, vendorId: passedVendor, quoteItemId }));

    expect(res.status).toBe(200);
    expect(res.body.message ?? "").not.toMatch(/technical/i);
    expect(await finalizationRow(rfq_id, passedVendor)).not.toBeNull();
  });

  // THE REGRESSION THAT MATTERS MOST. The overwhelmingly common RFQ has no
  // technical evaluation at all; breaking it would be far worse than the hole
  // being closed. Both guard conditions must fall through on NOT EXISTS.
  it("ALLOWS finalization on an RFQ with NO technical evaluation configured at all", async () => {
    const { rfq_id, rfq_no } = await makeFinalizableRfq();
    const vendor = IDS.users.vendor_alpha;
    const quoteItemId = await plantQuote(rfq_id, rfq_no, vendor, 500);
    // Deliberately NO seedProductTech — no tbl_rfq_product_tech_evaluation row
    // exists for this RFQ or its product.
    await seedPoHierarchy();

    const techRows = await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = $1`,
      [rfq_id]
    );
    expect(techRows.n).toBe(0); // fixture precondition, not the assertion

    const client = await httpClient(BUYER);
    const res = await client
      .post("/api/v1/rfq/finalize")
      .send(finalizeBody({ rfq_id, rfq_no, vendorId: vendor, quoteItemId }));

    expect(res.status).toBe(200);
    expect(await finalizationRow(rfq_id, vendor)).not.toBeNull();
  });

  // Condition 2 is per-product: an evaluation on a SIBLING product must not
  // make an unevaluated product unawardable, but Condition 1 still requires the
  // vendor to have cleared something in an RFQ that does run evaluation.
  it("ALLOWS a product with no evaluation of its own when the vendor cleared a sibling product in the same RFQ", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeFinalizableRfq();
    const vendor = IDS.users.vendor_alpha;
    const quoteItemId = await plantQuote(rfq_id, rfq_no, vendor, 500);

    // A sibling line that DOES carry a technical evaluation, which this vendor passed.
    const sibling = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 1) RETURNING id`,
      [rfq_id, VARIANT_A]
    );
    inserted.rfqProductIds.push(sibling.id);
    await seedProductTech(rfq_id, sibling.id, [{ vendorId: vendor, status: 1, score: 90 }], 50);
    // ...while rfq_product_id (variant 0, the line being awarded) has none.
    expect(
      (await db.one(
        `SELECT COUNT(*)::int AS n FROM tbl_rfq_product_tech_evaluation WHERE tbl_rfq_product_id = $1`,
        [rfq_product_id]
      )).n
    ).toBe(0);
    await seedPoHierarchy();

    const client = await httpClient(BUYER);
    const res = await client
      .post("/api/v1/rfq/finalize")
      .send(finalizeBody({ rfq_id, rfq_no, vendorId: vendor, quoteItemId }));

    expect(res.status).toBe(200);
    expect(await finalizationRow(rfq_id, vendor)).not.toBeNull();
  });

  it("REFUSES a vendor who cleared nothing anywhere in an RFQ that does run technical evaluation", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeFinalizableRfq();
    const uncleared = IDS.users.vendor_beta;
    const quoteItemId = await plantQuote(rfq_id, rfq_no, uncleared, 480);

    // Evaluation lives on a SIBLING line only, so the awarded line has none
    // (Condition 2 falls through) — but this vendor failed that sibling, so
    // Condition 1 must still hold them out of the whole RFQ.
    const sibling = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 1) RETURNING id`,
      [rfq_id, VARIANT_A]
    );
    inserted.rfqProductIds.push(sibling.id);
    await seedProductTech(rfq_id, sibling.id, [{ vendorId: uncleared, status: 0, score: 10 }], 50);
    expect(
      (await db.one(
        `SELECT COUNT(*)::int AS n FROM tbl_rfq_product_tech_evaluation WHERE tbl_rfq_product_id = $1`,
        [rfq_product_id]
      )).n
    ).toBe(0);
    await seedPoHierarchy();

    const client = await httpClient(BUYER);
    const res = await client
      .post("/api/v1/rfq/finalize")
      .send(finalizeBody({ rfq_id, rfq_no, vendorId: uncleared, quoteItemId }));

    expect(res.status).toBe(400);
    expect(res.body.status).toBe(2);
    expect(res.body.message).toMatch(/not cleared the technical evaluation for this RFQ/i);

    expect(await finalizationRow(rfq_id, uncleared)).toBeNull();
  });
});

// ============================================================================
// SECOND, ADJACENT DEFECT — the active-negotiation guard's coverage predicate.
//
// The refusal itself already existed, but it read the rfq_product_id COLUMN
// only. Rounds come in two persistence shapes and only the legacy one populates
// that column; multi-product and RFQ-level rounds set it NULL and carry their
// coverage in the `products` JSONB. So the guard fired for single-product
// rounds and missed every modern one — the buyer's sheet showed the line under
// negotiation ("R1 · 1 of 2 replied") while the server awarded it anyway.
//
// The first test below is the one that fails against the old predicate. The
// legacy test pins the behaviour that already worked so the widening does not
// regress it, and the last two pin the boundaries (expired must NOT block;
// the open-window test must be UTC-anchored).
// ============================================================================
describe("POST /rfq/finalize — active-negotiation guard covers multi-product rounds", () => {
  it("REFUSES when an ACTIVE MULTI-PRODUCT round covers the product via the products JSONB (rfq_product_id column NULL)", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeFinalizableRfq();
    const vendor = IDS.users.vendor_alpha;
    const quoteItemId = await plantQuote(rfq_id, rfq_no, vendor, 500);

    // A second line, so the round is genuinely multi-product.
    const sibling = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 1) RETURNING id`,
      [rfq_id, VARIANT_A]
    );
    inserted.rfqProductIds.push(sibling.id);

    await plantRound(rfq_id, {
      shape: "multi",
      coveredProductIds: [rfq_product_id, sibling.id],
    });
    // Precondition: coverage lives ONLY in the JSONB — this is exactly the row
    // shape the old column-based query could not see.
    const round = await db.one(
      `SELECT rfq_product_id, products FROM tbl_negotiation_rounds WHERE id = $1`,
      [inserted.roundIds[inserted.roundIds.length - 1]]
    );
    expect(round.rfq_product_id).toBeNull();
    expect(round.products.map((p) => p.rfq_product_id)).toContain(rfq_product_id);

    await seedPoHierarchy();
    const client = await httpClient(BUYER);
    const res = await client
      .post("/api/v1/rfq/finalize")
      .send(finalizeBody({ rfq_id, rfq_no, vendorId: vendor, quoteItemId }));

    expect(res.status).toBe(400);
    expect(res.body.status).toBe(2);
    expect(res.body.message).toMatch(/active negotiation round is ongoing/i);
    expect(await finalizationRow(rfq_id, vendor)).toBeNull();
  });

  it("REFUSES when an ACTIVE RFQ-LEVEL round covers the product", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeFinalizableRfq();
    const vendor = IDS.users.vendor_alpha;
    const quoteItemId = await plantQuote(rfq_id, rfq_no, vendor, 500);

    await plantRound(rfq_id, {
      shape: "multi",
      coveredProductIds: [rfq_product_id],
      rfqLevel: true,
    });

    await seedPoHierarchy();
    const client = await httpClient(BUYER);
    const res = await client
      .post("/api/v1/rfq/finalize")
      .send(finalizeBody({ rfq_id, rfq_no, vendorId: vendor, quoteItemId }));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/active negotiation round is ongoing/i);
    expect(await finalizationRow(rfq_id, vendor)).toBeNull();
  });

  it("still REFUSES a legacy single-product round carried on the rfq_product_id column", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeFinalizableRfq();
    const vendor = IDS.users.vendor_alpha;
    const quoteItemId = await plantQuote(rfq_id, rfq_no, vendor, 500);

    await plantRound(rfq_id, { shape: "legacy", coveredProductIds: [rfq_product_id] });

    await seedPoHierarchy();
    const client = await httpClient(BUYER);
    const res = await client
      .post("/api/v1/rfq/finalize")
      .send(finalizeBody({ rfq_id, rfq_no, vendorId: vendor, quoteItemId }));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/active negotiation round is ongoing/i);
    expect(await finalizationRow(rfq_id, vendor)).toBeNull();
  });

  it("ALLOWS finalization once a multi-product round's window has closed", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeFinalizableRfq();
    const vendor = IDS.users.vendor_alpha;
    const quoteItemId = await plantQuote(rfq_id, rfq_no, vendor, 500);

    // Still status ACTIVE (the deadline cron may not have run), but the window
    // is past — the round is over and must not block the award.
    await plantRound(rfq_id, {
      shape: "multi",
      coveredProductIds: [rfq_product_id],
      endsInHoursUtc: -24,
    });

    await seedPoHierarchy();
    const client = await httpClient(BUYER);
    const res = await client
      .post("/api/v1/rfq/finalize")
      .send(finalizeBody({ rfq_id, rfq_no, vendorId: vendor, quoteItemId }));

    expect(res.status).toBe(200);
    expect(await finalizationRow(rfq_id, vendor)).not.toBeNull();
  });

  it("ALLOWS finalization when an ACTIVE multi-product round covers only OTHER products", async () => {
    const { rfq_id, rfq_no } = await makeFinalizableRfq();
    const vendor = IDS.users.vendor_alpha;
    const quoteItemId = await plantQuote(rfq_id, rfq_no, vendor, 500);

    const other = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 1) RETURNING id`,
      [rfq_id, VARIANT_A]
    );
    inserted.rfqProductIds.push(other.id);
    // Round covers the SIBLING only — widening the predicate must not turn into
    // "any active round anywhere in the RFQ blocks everything".
    await plantRound(rfq_id, { shape: "multi", coveredProductIds: [other.id] });

    await seedPoHierarchy();
    const client = await httpClient(BUYER);
    const res = await client
      .post("/api/v1/rfq/finalize")
      .send(finalizeBody({ rfq_id, rfq_no, vendorId: vendor, quoteItemId }));

    expect(res.status).toBe(200);
    expect(await finalizationRow(rfq_id, vendor)).not.toBeNull();
  });

  // The open-window comparator must be `now() AT TIME ZONE 'UTC'`, not
  // session-TZ NOW(). end_date sits 1h ahead in UTC — genuinely still open.
  // On an IST session (the default local Postgres) NOW() runs 5h30m ahead of
  // UTC wall clock, so the OLD `end_date > NOW()` read this open round as
  // already expired and waved the award through. Under a UTC session (CI, prod)
  // the two comparators coincide, so this case is discriminating locally and
  // merely correct in CI — which is the right way round, since the local
  // machine is where the wrong comparator looks fine.
  it("treats the round window as UTC wall clock, not session-timezone NOW()", async () => {
    const { rfq_id, rfq_no, rfq_product_id } = await makeFinalizableRfq();
    const vendor = IDS.users.vendor_alpha;
    const quoteItemId = await plantQuote(rfq_id, rfq_no, vendor, 500);

    await plantRound(rfq_id, {
      shape: "multi",
      coveredProductIds: [rfq_product_id],
      endsInHoursUtc: 1,
    });

    await seedPoHierarchy();
    const client = await httpClient(BUYER);
    const res = await client
      .post("/api/v1/rfq/finalize")
      .send(finalizeBody({ rfq_id, rfq_no, vendorId: vendor, quoteItemId }));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/active negotiation round is ongoing/i);
    expect(await finalizationRow(rfq_id, vendor)).toBeNull();
  });
});
