// Wave: GET /api/v1/rfq/quote-comparison-view/:id
// ----------------------------------------------------------------------------
// Product-level integration tests over real HTTP (supertest -> buildTestApp)
// against the local Postgres seed. Exercises the NEW read-only buyer-facing
// "Quote Comparison" contract endpoint:
//
//   GET /rfq/quote-comparison-view/:id  (passportSignIn + noAcl([3]))
//
// The controller (rfqController.getQuoteComparisonView) reshapes the existing
// comparison pipeline output (quoteCompareViewModel.getQuoteComparisonView)
// into the flat "QC contract" and returns it DIRECTLY with a 200, or 404 when
// the RFQ is out of scope / not found.
//
// TENANT-SCOPE STRATEGY (the crux):
//   The view controller derives scope via poDashboardController.deriveScope(req).
//   The model's ONLY tenant gate (quoteCompareViewModel L100-104) compares
//   scope.hospitalityCompanyId (which deriveScope sources from the
//   x-company-id / x-hospitality-company header) against the RFQ's
//   hospitality_company_id. There is NO companyId fallback gate on this view —
//   so, unlike po.dashboard.test.js, we MUST send the hospitality header to
//   engage isolation. We therefore:
//     - send `x-hospitality-company: IDS.hospitality.A` for the in-scope A
//       buyer (matches the seeded RFQ's hospitality_company_id -> 200), and
//     - send `x-hospitality-company: IDS.hospitality.B` for the company-B buyer
//       (does NOT match the A RFQ -> 404, no leak).
//   The header value flows through deriveScope unchanged; the data fetch itself
//   uses rfq.hospitality_company_id, so a matching header never alters results.
//
// STATE SEEDING:
//   Per-product state (open|pending|approved|rejected) is derived from
//   tbl_quote_finalization + the latest NEGOTIATION_QUOTE approval instance
//   whose entity_id = rfq_product_id. We mirror po.dashboard.test.js's
//   make*Approval helpers but with entity_type 'NEGOTIATION_QUOTE' and
//   entity_id = rfq_product_id, plus a finalization row keyed by
//   (rfq_id, product_variant_id, variant, vendor_id).
//
// All inserted rows are tracked and removed in afterEach (mirrors
// po.dashboard.test.js cleanup discipline). The httpClient is built per-test.

import {
  describe, it, expect, afterAll, beforeAll, beforeEach, afterEach,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";

afterAll(async () => {
  await closeDb();
});

// Two real product_variant ids from the staging snapshot (so the model's
// category/name joins through tbl_product_variant resolve cleanly).
let VARIANT_A = 1;
let VARIANT_B = 2;

beforeAll(async () => {
  const vs = await db.any(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 2`);
  if (vs[0]) VARIANT_A = vs[0].id;
  if (vs[1]) VARIANT_B = vs[1].id;
});

// ---- Row tracking -----------------------------------------------------------
const inserted = {
  rfqIds: [],
  rfqProductIds: [],
  quoteIds: [],
  finalizationIds: [],
  approvalInstanceIds: [],
  approvalStepIds: [],
  approverIds: [],
  techEvalIds: [],
};

beforeEach(() => {
  for (const k of Object.keys(inserted)) inserted[k] = [];
});

afterEach(async () => {
  if (inserted.approverIds.length) {
    await db.none(`DELETE FROM tbl_approval_step_approvers WHERE id = ANY($1::int[])`, [inserted.approverIds]);
  }
  if (inserted.approvalStepIds.length) {
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE id = ANY($1::int[])`, [inserted.approvalStepIds]);
  }
  if (inserted.approvalInstanceIds.length) {
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [inserted.approvalInstanceIds]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [inserted.approvalInstanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [inserted.approvalInstanceIds]);
  }
  if (inserted.techEvalIds.length) {
    await db.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation_cleared_vendors
        WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[])`,
      [inserted.techEvalIds]
    );
    await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation WHERE id = ANY($1::int[])`, [inserted.techEvalIds]);
  }
  if (inserted.finalizationIds.length) {
    await db.none(`DELETE FROM tbl_quote_finalization WHERE id = ANY($1::int[])`, [inserted.finalizationIds]);
  }
  if (inserted.quoteIds.length) {
    await db.none(
      `DELETE FROM tbl_quote_item_history
        WHERE quote_item_id IN (SELECT id FROM tbl_quote_items WHERE quote_id = ANY($1::int[]))`,
      [inserted.quoteIds]
    );
    await db.none(`DELETE FROM tbl_quote_items WHERE quote_id = ANY($1::int[])`, [inserted.quoteIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE id = ANY($1::int[])`, [inserted.quoteIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  }
  if (inserted.rfqProductIds.length) {
    await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1::int[])`, [inserted.rfqProductIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_quote_activity WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
});

// ---- Setup helpers ----------------------------------------------------------

// A timestamp string N ms from now, in the "YYYY-MM-DD HH:mm:ss" shape the
// codebase stores bid_end_date in (so quote visibility unlocks once past).
const tsString = (offsetMs) =>
  new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);

// Hospitality-company header => engages the model's tenant gate (deriveScope
// reads x-hospitality-company). loginAs() returns Authorization+User-Agent;
// we layer the scope header on per-request.
const HOSP_HEADER = "x-hospitality-company";

async function makeViewableRfq({
  hospitality = IDS.hospitality.A,
  hotel = IDS.hotels.A1,
  createdBy = IDS.users.a1_proc_buyer,
  bidEndOffsetMs = -3600_000, // default: past deadline => quotes UNLOCKED
} = {}) {
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy,
    status: 1,
    is_published: 1,
    tender_publish_date: tsString(-2 * 86400_000),
    vendor_clarification_date: tsString(-86400_000),
    bid_end_date: tsString(bidEndOffsetMs),
    hospitality,
    hotel,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);
  return { rfq_id, rfq_no };
}

async function addProduct(rfq_id, productVariantId = VARIANT_A, variant = 0) {
  const row = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, $3) RETURNING id`,
    [rfq_id, productVariantId, variant]
  );
  inserted.rfqProductIds.push(row.id);
  return { rfq_product_id: row.id, product_variant_id: productVariantId, variant };
}

// Seed a vendor quote + line item for a product. otherCharges drives the
// engine's freight/packaging breakdown (a "freight" slug surfaces per-cell
// freight; without it, the cell's freight is 0 and `missing` flips true).
async function plantQuote(
  rfq_id, rfq_no, vendorId,
  { unitPrice, quantity = 10, tax = 18, otherCharges = [], productVariantId = VARIANT_A, variant = 0 }
) {
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [rfq_id, productVariantId, vendorId, variant]
  );
  const q = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
     VALUES ($1, $2, $3, $3, 1, NOW()) RETURNING id`,
    [rfq_id, rfq_no, vendorId]
  );
  inserted.quoteIds.push(q.id);
  await db.none(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
        package_price, tax, freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
     VALUES ($1, $2, $3, $9, $4, $5, 0, $6, 0, $10, '', '7', $7, 'percentage', $8)`,
    [
      rfq_id, rfq_no, q.id, unitPrice, unitPrice * quantity, tax,
      String(quantity), JSON.stringify(otherCharges), productVariantId, variant,
    ]
  );
  return q.id;
}

// A freight charge so per-cell `total` includes landed freight (and `?freight=0`
// can drop it). slug 'freight' is what chargeSubtotal(engine, 'freight') reads.
const FREIGHT_CHARGE = [
  { name: "Freight", slug: "freight", amount: 10, amount_mode: "percentage", tax: 0, tax_mode: "percentage", comment: "" },
];

// Seed prior negotiation rounds (tbl_quote_item_history) for a planted quote.
// rows: [{ unit_price, total_price, comment, timestamp }]. The model returns
// these newest-first; the view model reverses them oldest-first for history.
async function seedQuoteHistory(quote_id, productVariantId, rows) {
  const qi = await db.oneOrNone(
    `SELECT id, rfq_id, variant FROM tbl_quote_items
      WHERE quote_id = $1 AND product_variant_id = $2 LIMIT 1`,
    [quote_id, productVariantId]
  );
  if (!qi) return;
  for (const r of rows) {
    await db.none(
      `INSERT INTO tbl_quote_item_history
         (quote_item_id, rfq_id, product_variant_id, unit_price, total_price, comment, variant, "timestamp")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [qi.id, qi.rfq_id, productVariantId, r.unit_price, r.total_price, r.comment, qi.variant, r.timestamp]
    );
  }
}

// Mark a product finalized to `vendorId` (keyed by rfq_id, product_variant_id,
// variant per the model's fetchFinalizations).
async function finalizeProduct(rfq_id, rfq_no, quote_id, productVariantId, vendorId, variant = 0) {
  const r = await db.one(
    `INSERT INTO tbl_quote_finalization
       (rfq_id, rfq_no, quote_id, product_variant_id, vendor_id, created_by, variant)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [rfq_id, rfq_no, quote_id, productVariantId, vendorId, IDS.users.a1_proc_buyer, variant]
  );
  inserted.finalizationIds.push(r.id);
  return r.id;
}

// Configure technical evaluation for one product and seed per-vendor scores.
// scores: [{ vendorId, score, status }] (status 1 = passed/cleared, anything
// else = failed; omit a vendor entirely to leave them unevaluated). Presence of
// the te row makes product.tech.configured true; calculated_score drives T-rank.
// `minScore` is the product's minimum_passing_score, surfaced on the contract's
// quotes_absence entries so the buyer sees "scored X against a minimum of Y".
async function seedProductTech(rfq_id, rfq_product_id, scores = [], minScore = 0) {
  const te = await db.one(
    `INSERT INTO tbl_rfq_product_tech_evaluation (rfq_id, tbl_rfq_product_id, minimum_passing_score)
     VALUES ($1, $2, $3) RETURNING id`,
    [rfq_id, rfq_product_id, minScore]
  );
  inserted.techEvalIds.push(te.id);
  for (const s of scores) {
    await db.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation_cleared_vendors
         (tbl_rfq_product_tech_evaluation_id, vendor_id, status, calculated_score, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [te.id, s.vendorId, s.status ?? 1, s.score, IDS.users.a1_proc_buyer]
    );
  }
  return te.id;
}

// Create a NEGOTIATION_QUOTE approval instance whose entity_id = rfq_product_id,
// with one step + one approver, mirroring po.dashboard.test.js's shape.
// `status`: PENDING | APPROVED | REJECTED. If REJECTED and reason is provided,
// also seed the REJECT action carrying the comment (read by fetchQuoteApprovals).
async function makeQuoteApproval({
  rfq_product_id,
  status,
  approverUserId = IDS.users.a1_proc_commApp,
  reason = null,
  hospitality = IDS.hospitality.A,
  hotel = IDS.hotels.A1,
}) {
  const stepStatus = status === "PENDING" ? "PENDING" : status;
  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by, process_id)
     VALUES ('NEGOTIATION_QUOTE', $1, $2, $3, 1, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      rfq_product_id, IDS.policies.A1_P1_NEGOTIATION_QUOTE, status,
      hospitality, hotel, IDS.departments.proc, IDS.users.a1_proc_buyer, IDS.processes.A_P1,
    ]
  );
  inserted.approvalInstanceIds.push(inst.id);

  const step = await db.one(
    `INSERT INTO tbl_approval_instance_steps
       (approval_instance_id, step_order, decision_rule, status)
     VALUES ($1, 1, 'ANY', $2) RETURNING id`,
    [inst.id, stepStatus]
  );
  inserted.approvalStepIds.push(step.id);

  const appr = await db.one(
    `INSERT INTO tbl_approval_step_approvers
       (approval_instance_step_id, approver_user_id, status)
     VALUES ($1, $2, $3) RETURNING id`,
    [step.id, approverUserId, stepStatus]
  );
  inserted.approverIds.push(appr.id);

  if (status === "REJECTED" && reason != null) {
    await db.none(
      `INSERT INTO tbl_approval_actions
         (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
       VALUES ($1, $2, $3, 'REJECT', $4)`,
      [inst.id, step.id, approverUserId, reason]
    );
  }
  return inst.id;
}

// Build a client whose every request carries the hospitality scope header.
async function scopedClient(userId, hospitalityId = IDS.hospitality.A) {
  const c = await httpClient(userId);
  return {
    get: (path) => c.get(path).set(HOSP_HEADER, String(hospitalityId)),
  };
}

const VIEW = (id) => `/api/v1/rfq/quote-comparison-view/${id}`;

// ===========================================================================
// 1) Shape — in-scope buyer gets 200; documented top-level contract present.
// ===========================================================================
describe("GET /rfq/quote-comparison-view/:id — contract shape", () => {
  it("returns 200 with rfq/vendors/categories/products/approval_chain and correct types", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));

    expect(res.status).toBe(200);
    const body = res.body;

    // Top-level keys present + typed.
    expect(body.rfq).toBeDefined();
    expect(Array.isArray(body.vendors)).toBe(true);
    expect(Array.isArray(body.categories)).toBe(true);
    expect(Array.isArray(body.products)).toBe(true);
    expect(Array.isArray(body.approval_chain)).toBe(true);

    // rfq.number is the rfq_no as a string.
    expect(typeof body.rfq.number).toBe("string");
    expect(body.rfq.number).toBe(String(rfq_no));
    expect(body.rfq.rounds).toBeDefined();
    for (const k of ["active", "pending", "ended"]) {
      expect(typeof body.rfq.rounds[k]).toBe("number");
    }
    expect(typeof body.rfq.quotes_received).toBe("number");
    expect(typeof body.rfq.quotes_invited).toBe("number");
    expect(typeof body.rfq.tech_clauses).toBe("boolean");

    // vendors[] carries the documented vendor cell shape.
    const vendor = body.vendors.find((v) => v.id === IDS.users.vendor_alpha);
    expect(vendor).toBeDefined();
    expect(typeof vendor.name).toBe("string");
    expect(typeof vendor.short).toBe("string");
    expect(vendor).toHaveProperty("tech");
    expect(vendor).toHaveProperty("tech_score");

    // Per-vendor performance fields: orders_done is a REAL numeric count;
    // track_record + on_time_pct keys are present (value may be null).
    expect(typeof vendor.orders_done).toBe("number");
    expect(vendor.orders_done).toBeGreaterThanOrEqual(0);
    expect(vendor).toHaveProperty("track_record");
    expect(vendor).toHaveProperty("on_time_pct");

    // Per-vendor track-record fields (cell indicators): typed + sane ranges.
    expect(typeof vendor.pos_accepted).toBe("number");
    expect(vendor.pos_accepted).toBeGreaterThanOrEqual(0);
    expect(typeof vendor.po_value).toBe("number");
    expect(typeof vendor.quoted_rfqs).toBe("number");
    expect(typeof vendor.invited_rfqs).toBe("number");
    expect(typeof vendor.is_new).toBe("boolean");
    // is_new is the "<3 accepted POs" signal, consistent with pos_accepted.
    expect(vendor.is_new).toBe(vendor.pos_accepted < 3);
    // quote_pct is null (no invites) or a 0-100 integer.
    if (vendor.quote_pct !== null) {
      expect(vendor.quote_pct).toBeGreaterThanOrEqual(0);
      expect(vendor.quote_pct).toBeLessThanOrEqual(100);
    }

    // categories[] elements have {id, name}.
    expect(body.categories.length).toBeGreaterThanOrEqual(1);
    for (const c of body.categories) {
      expect(c).toHaveProperty("id");
      expect(typeof c.name).toBe("string");
    }

    // products[] is an array; each product's quotes map is keyed by vendor id
    // with the documented cell keys (or null).
    expect(body.products.length).toBe(1);
    const product = body.products[0];
    expect(typeof product.id).toBe("number");
    expect(typeof product.name).toBe("string");
    expect(product.lpr).toHaveProperty("rate");
    expect(product.lpr).toHaveProperty("date");
    expect(product.round).toBeDefined();
    expect(["open", "pending", "approved", "rejected"]).toContain(product.state);
    expect(product.quotes).toBeDefined();
    expect(Object.keys(product.quotes)).toContain(String(IDS.users.vendor_alpha));

    const cell = product.quotes[String(IDS.users.vendor_alpha)];
    expect(cell).not.toBeNull();
    for (const k of [
      "base", "subtotal", "freight", "packaging", "tax_pct", "tax_amt",
      "delivery", "pay", "comment", "docs", "missing", "total",
      "other_charges", "global_charges",
    ]) {
      expect(cell).toHaveProperty(k);
    }
    // The new other_charges / global_charges keys are always arrays.
    expect(Array.isArray(cell.other_charges)).toBe(true);
    expect(Array.isArray(cell.global_charges)).toBe(true);

    // CONSOLIDATION: the cell carries everything the FE needs to finalize +
    // show history (so it no longer hits the legacy quote-compare endpoint).
    expect(cell.finalize).toBeDefined();
    for (const k of ["quote_id", "quote_item_id", "vendor_id", "unit_price", "total_value", "charges_meta"]) {
      expect(cell.finalize).toHaveProperty(k);
    }
    expect(typeof cell.finalize.quote_id).toBe("number");
    expect(typeof cell.finalize.quote_item_id).toBe("number");
    expect(cell.finalize.vendor_id).toBe(IDS.users.vendor_alpha);
    expect(cell.finalize.charges_meta).toHaveProperty("other_charges");
    expect(Array.isArray(cell.history)).toBe(true);
    // Single submission => one history row, flagged final.
    expect(cell.history.length).toBe(1);
    expect(cell.history[0].final).toBe(true);

    // Product identity for the finalize payload.
    expect(typeof product.product_variant_id).toBe("number");
    expect(typeof product.variant).toBe("number");

    // RFQ block carries the finalize-level identifiers.
    expect(typeof body.rfq.id).toBe("number");
    expect(typeof body.rfq.rfq_no).toBe("number");
    expect(body.rfq).toHaveProperty("project_id");

    // product.tech block: configured flag + scores object (empty when no tech eval).
    expect(product.tech).toBeDefined();
    expect(typeof product.tech.configured).toBe("boolean");
    expect(product.tech.configured).toBe(false); // no tech eval seeded here
    expect(product.tech.scores).toEqual({});
  });
});

// ===========================================================================
// 1b) Technical — per-product config flag + per-vendor scores power T-rank.
// ===========================================================================
describe("GET /rfq/quote-comparison-view/:id — per-product technical scores", () => {
  it("exposes tech.configured + per-vendor scores when a tech evaluation exists", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id, product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_beta, {
      unitPrice: 600, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });
    // alpha scores 72, beta scores 88 → beta is the technical winner (T1).
    await seedProductTech(rfq_id, rfq_product_id, [
      { vendorId: IDS.users.vendor_alpha, score: 72.4, status: 1 },
      { vendorId: IDS.users.vendor_beta, score: 88.0, status: 1 },
    ]);

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    expect(res.status).toBe(200);

    const product = res.body.products.find((p) => p.id === rfq_product_id);
    expect(product).toBeDefined();
    expect(product.tech.configured).toBe(true);
    // scores are rounded ints keyed by vendor id.
    expect(product.tech.scores[String(IDS.users.vendor_alpha)]).toBe(72);
    expect(product.tech.scores[String(IDS.users.vendor_beta)]).toBe(88);
    // The highest score belongs to beta → would be T1 on the FE.
    const top = Object.entries(product.tech.scores).sort((a, b) => b[1] - a[1])[0][0];
    expect(top).toBe(String(IDS.users.vendor_beta));

    // rfq.tech_clauses also reflects that this RFQ has a tech evaluation.
    expect(res.body.rfq.tech_clauses).toBe(true);
  });

  it("tech.configured is false and scores empty for a product without a tech evaluation", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id, product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    expect(res.status).toBe(200);

    const product = res.body.products.find((p) => p.id === rfq_product_id);
    expect(product.tech.configured).toBe(false);
    expect(product.tech.scores).toEqual({});
  });
});

// ===========================================================================
// 1b-ii) quotes_absence — WHY a cell is empty.
//
// The bug this locks down: getQuotesByRfqById2 is called with TA_Vendors='TA',
// whose SQL gate drops the whole quotation of a vendor who failed THIS
// product's technical evaluation. The cell then collapsed to a bare `null` —
// indistinguishable from a vendor who never responded — so the buyer's primary
// commercial screen rendered "Awaiting quote" over a vendor who competed and
// was disqualified by the buyer's own technical gate, and the vendor column
// counted that line as un-quoted ("Partial — 2 of 3 items quoted").
//
// The price stays suppressed (a disqualified vendor must remain non-comparable
// and non-awardable — quotes[vendor] is still null, so there is no `finalize`
// payload and no selectable cell). Only the REASON is added, in a sibling map.
//
// Reproduced from RFQ 363 (#535917) on staging: vendor 429 quoted a LAPTOP
// SCREEN line at ₹1,14,000.04, scored 20 against a 50 minimum, and was recorded
// FAIL — while passing the other two products, which is what keeps them in the
// vendors[] column set at all.
// ===========================================================================
describe("GET /rfq/quote-comparison-view/:id — quotes_absence (why a cell is empty)", () => {
  // Three vendors, ONE product, three different reasons for the cell's state.
  // Every vendor also quotes a second product they pass, because the 'TA' gate
  // additionally requires a vendor to clear at least one product in the RFQ —
  // otherwise they vanish from vendors[] entirely and have no column to explain.
  async function seedThreeCases() {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const A = await addProduct(rfq_id, VARIANT_A);          // the product under test
    const B = await addProduct(rfq_id, VARIANT_B, 0);       // the "carrier" product

    // --- product A: alpha quotes and passes, beta quotes and FAILS ---
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE,
      productVariantId: A.product_variant_id,
    });
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_beta, {
      unitPrice: 600, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE,
      productVariantId: A.product_variant_id,
    });
    // gamma NEVER quotes product A — the genuine non-response.

    // --- product B: beta + gamma quote and pass, which puts both in vendors[] ---
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_beta, {
      unitPrice: 700, quantity: 5, tax: 18, otherCharges: FREIGHT_CHARGE,
      productVariantId: B.product_variant_id,
    });
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_gamma, {
      unitPrice: 800, quantity: 5, tax: 18, otherCharges: FREIGHT_CHARGE,
      productVariantId: B.product_variant_id,
    });

    await seedProductTech(rfq_id, A.rfq_product_id, [
      { vendorId: IDS.users.vendor_alpha, score: 80, status: 1 },
      { vendorId: IDS.users.vendor_beta, score: 20, status: 0 },
    ], 50);
    await seedProductTech(rfq_id, B.rfq_product_id, [
      { vendorId: IDS.users.vendor_beta, score: 70, status: 1 },
      { vendorId: IDS.users.vendor_gamma, score: 60, status: 1 },
    ], 50);

    return { rfq_id, A, B };
  }

  it("distinguishes quoted-and-passed, quoted-but-tech-failed and never-quoted on the SAME product", async () => {
    const { rfq_id, A } = await seedThreeCases();

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    expect(res.status).toBe(200);

    const product = res.body.products.find((p) => p.id === A.rfq_product_id);
    expect(product).toBeDefined();

    const alpha = String(IDS.users.vendor_alpha);
    const beta = String(IDS.users.vendor_beta);
    const gamma = String(IDS.users.vendor_gamma);

    // All three are columns on the sheet — otherwise there is nothing to label.
    const vendorIds = res.body.vendors.map((v) => String(v.id));
    expect(vendorIds).toEqual(expect.arrayContaining([alpha, beta, gamma]));

    // 1) quoted AND passed -> a real, priced cell.
    expect(product.quotes[alpha]).not.toBeNull();
    expect(product.quotes[alpha].base).toBeGreaterThan(0);
    expect(product.quotes_absence[alpha]).toBeUndefined();

    // 2) quoted BUT technically failed -> price still suppressed, reason carried.
    expect(product.quotes[beta]).toBeNull();
    expect(product.quotes_absence[beta]).toEqual({
      status: "TECH_FAILED",
      tech_score: 20,
      min_score: 50,
    });

    // 3) never quoted -> no cell AND no reason. This is what "Awaiting quote"
    //    is allowed to mean, and the only case that may still say it.
    expect(product.quotes[gamma]).toBeNull();
    expect(product.quotes_absence[gamma]).toBeUndefined();
  });

  it("keeps the disqualified vendor non-awardable: the null cell carries no finalize payload", async () => {
    const { rfq_id, A } = await seedThreeCases();

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    const product = res.body.products.find((p) => p.id === A.rfq_product_id);

    // The FE builds its award payload from cell.finalize (quote_id /
    // quote_item_id / vendor_id). A disqualified vendor must never expose one —
    // this is what makes the suppression real rather than cosmetic.
    expect(product.quotes[String(IDS.users.vendor_beta)]).toBeNull();
    expect(product.quotes_absence[String(IDS.users.vendor_beta)].status).toBe("TECH_FAILED");
    // …while the vendor who passed still has one.
    expect(product.quotes[String(IDS.users.vendor_alpha)].finalize.quote_id).toEqual(expect.any(Number));
  });

  it("suppression is per-product: the same vendor keeps a live cell on a product they passed", async () => {
    const { rfq_id, B } = await seedThreeCases();

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    const productB = res.body.products.find((p) => p.id === B.rfq_product_id);

    expect(productB.quotes[String(IDS.users.vendor_beta)]).not.toBeNull();
    expect(productB.quotes_absence).toEqual({});
  });

  it("marks a vendor with no technical verdict yet as TECH_PENDING, not as a non-response", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const A = await addProduct(rfq_id, VARIANT_A);
    const B = await addProduct(rfq_id, VARIANT_B, 0);

    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE,
      productVariantId: A.product_variant_id,
    });
    // delta quotes product A but nobody has scored them on it yet.
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_delta, {
      unitPrice: 650, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE,
      productVariantId: A.product_variant_id,
    });
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_delta, {
      unitPrice: 900, quantity: 5, tax: 18, otherCharges: FREIGHT_CHARGE,
      productVariantId: B.product_variant_id,
    });

    await seedProductTech(rfq_id, A.rfq_product_id, [
      { vendorId: IDS.users.vendor_alpha, score: 80, status: 1 },
      // deliberately NO row for delta
    ], 50);
    await seedProductTech(rfq_id, B.rfq_product_id, [
      { vendorId: IDS.users.vendor_delta, score: 75, status: 1 },
    ], 50);

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    expect(res.status).toBe(200);

    const product = res.body.products.find((p) => p.id === A.rfq_product_id);
    expect(product.quotes[String(IDS.users.vendor_delta)]).toBeNull();
    expect(product.quotes_absence[String(IDS.users.vendor_delta)]).toEqual({
      status: "TECH_PENDING",
      tech_score: null,
      min_score: 50,
    });
  });

  it("is empty for an RFQ with no technical evaluation at all", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id, product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    const product = res.body.products.find((p) => p.id === rfq_product_id);
    expect(product.quotes_absence).toEqual({});
  });

  it("redacts quotes_absence before the deadline, like tech.scores", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq({ bidEndOffsetMs: 86400_000 });
    const A = await addProduct(rfq_id, VARIANT_A);
    const B = await addProduct(rfq_id, VARIANT_B, 0);
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_beta, {
      unitPrice: 600, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE,
      productVariantId: A.product_variant_id,
    });
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_beta, {
      unitPrice: 700, quantity: 5, tax: 18, otherCharges: FREIGHT_CHARGE,
      productVariantId: B.product_variant_id,
    });
    await seedProductTech(rfq_id, A.rfq_product_id, [
      { vendorId: IDS.users.vendor_beta, score: 20, status: 0 },
    ], 50);
    await seedProductTech(rfq_id, B.rfq_product_id, [
      { vendorId: IDS.users.vendor_beta, score: 70, status: 1 },
    ], 50);

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    expect(res.body.quotes_locked).toBe(true);
    for (const p of res.body.products) {
      expect(p.quotes_absence).toEqual({});
    }
  });
});

// ===========================================================================
// 1c) Pre-deadline lock — quotes hidden until bid_end_date passes.
// ===========================================================================
describe("GET /rfq/quote-comparison-view/:id — pre-deadline lock", () => {
  it("hides all quote numbers + vendor identity but reveals quoted_count before the deadline", async () => {
    // Deadline 1 day in the FUTURE => quotes must stay sealed.
    const { rfq_id, rfq_no } = await makeViewableRfq({ bidEndOffsetMs: 86400_000 });
    const { product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_beta, {
      unitPrice: 600, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    expect(res.status).toBe(200);
    const body = res.body;

    // Lock flag + deadline surfaced.
    expect(body.quotes_locked).toBe(true);
    expect(typeof body.bid_end_date).toBe("string");

    const product = body.products[0];
    // Count of quoting vendors is revealed (so the buyer knows quotes exist).
    expect(product.quoted_count).toBe(2);

    // Every non-null cell is a scrubbed placeholder — NO real numbers leak.
    const cells = Object.values(product.quotes).filter((c) => c != null);
    expect(cells.length).toBe(2);
    for (const cell of cells) {
      expect(cell).toEqual({ locked: true });
      expect(cell.total).toBeUndefined();
      expect(cell.base).toBeUndefined();
    }

    // Vendor identity + metrics are masked.
    for (const v of body.vendors) {
      expect(v.name).toBe("Hidden until deadline");
      expect(v.tech_score).toBeNull();
      expect(v.pos_accepted).toBeNull();
      expect(v.po_value).toBeNull();
    }

    // No leaked per-product technical scores either.
    expect(product.tech.scores).toEqual({});

    // The two fields added for the award badge and the in-row negotiation are
    // decision data of exactly the same kind as the fields above, and must not
    // survive the lock just because they were added later.
    expect(product.finalized_by).toBeNull();
    expect(product.negotiation).toBeNull();

    // And there is nothing to toggle when every cell is a placeholder.
    expect(body.has_delivery_charges).toBe(false);
  });

  it("is unlocked (real numbers present) once the deadline has passed", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq({ bidEndOffsetMs: -3600_000 });
    const { product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    expect(res.status).toBe(200);

    expect(res.body.quotes_locked).toBe(false);
    const cell = res.body.products[0].quotes[String(IDS.users.vendor_alpha)];
    expect(cell).not.toBeNull();
    expect(typeof cell.total).toBe("number");
    expect(cell.locked).toBeUndefined();
  });
});

// ===========================================================================
// 1d) Consolidation — per-cell round history (replaces the legacy 2nd call).
// ===========================================================================
describe("GET /rfq/quote-comparison-view/:id — per-cell round history", () => {
  it("ships previous_quotes oldest→newest + current with round numbers and deltas", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    const quoteId = await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });
    // Two prior rounds (R1 older, R2 newer); the model returns them newest-first.
    await seedQuoteHistory(quoteId, product_variant_id, [
      { unit_price: 600, total_price: 6000, comment: "Round 1", timestamp: tsString(-3 * 86400_000) },
      { unit_price: 550, total_price: 5500, comment: "Round 2", timestamp: tsString(-2 * 86400_000) },
    ]);

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    expect(res.status).toBe(200);

    const cell = res.body.products[0].quotes[String(IDS.users.vendor_alpha)];
    const h = cell.history;
    expect(h.length).toBe(3); // 2 prior rounds + current submission
    expect(h.map((r) => r.round)).toEqual([1, 2, 3]); // oldest → newest
    expect(h[0].price).toBe(600);
    expect(h[1].price).toBe(550);
    expect(h[2].price).toBe(500);
    expect(h[2].final).toBe(true);
    expect(h[0].delta).toBeNull(); // first round has no prior
    expect(h[1].delta).toBe(50); // 600 → 550 (positive = price dropped)
    expect(h[2].delta).toBe(50); // 550 → 500

    // Each non-first round lists WHAT changed (not just the base price).
    expect(Array.isArray(h[0].changes)).toBe(true);
    expect(h[0].changes.length).toBe(0); // first round: nothing to diff
    const up = h[1].changes.find((c) => c.label === "Unit price");
    expect(up).toBeDefined();
    expect(up.from).toBe(600);
    expect(up.to).toBe(550);
    expect(up.dir).toBe("down"); // price decreased
  });

  it("flags a price INCREASE round-over-round with dir 'up'", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    // Current submission is 500; the only prior round was cheaper (450) → it rose.
    const quoteId = await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });
    await seedQuoteHistory(quoteId, product_variant_id, [
      { unit_price: 450, total_price: 4500, comment: "Round 1", timestamp: tsString(-2 * 86400_000) },
    ]);

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    const h = res.body.products[0].quotes[String(IDS.users.vendor_alpha)].history;
    expect(h.length).toBe(2);
    expect(h[1].delta).toBe(-50); // 450 → 500, negative = price increased
    const up = h[1].changes.find((c) => c.label === "Unit price");
    expect(up.dir).toBe("up");
    expect(up.from).toBe(450);
    expect(up.to).toBe(500);
  });
});

// ===========================================================================
// 2) Cells — quoted vendor -> non-null numeric cell; un-quoted vendor -> null.
// ===========================================================================
describe("GET /rfq/quote-comparison-view/:id — per-cell quotes map", () => {
  it("a vendor who quoted has a numeric base+total; a vendor who didn't is null", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { product_variant_id } = await addProduct(rfq_id, VARIANT_A);

    // alpha quotes product A; beta is invited to the RFQ (so it joins vendors[])
    // but quotes a DIFFERENT product, so its cell on product A must be null.
    const { product_variant_id: pvB } = await addProduct(rfq_id, VARIANT_B);
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_beta, {
      unitPrice: 700, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: pvB,
    });

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    expect(res.status).toBe(200);

    // Both vendors appear in the union vendors[].
    const vendorIds = res.body.vendors.map((v) => v.id);
    expect(vendorIds).toContain(IDS.users.vendor_alpha);
    expect(vendorIds).toContain(IDS.users.vendor_beta);

    const productA = res.body.products.find((p) => p.id === inserted.rfqProductIds[0]);
    expect(productA).toBeDefined();

    const alphaCell = productA.quotes[String(IDS.users.vendor_alpha)];
    expect(alphaCell).not.toBeNull();
    // Documented cell carries numeric base & total (engine landed total).
    expect(typeof alphaCell.base).toBe("number");
    expect(typeof alphaCell.total).toBe("number");
    expect(alphaCell.total).toBeGreaterThan(0);

    // REAL money components must be non-zero for a real quote. The seed plants
    // unit_price=500 x quantity=10, so the engine produces base sub-total 5000
    // and a per-unit base of 500. Before the fix these came back 0 because the
    // model read detail.unit_price (which sits on the parent quote in this shape).
    expect(alphaCell.base).toBeGreaterThan(0);
    expect(alphaCell.subtotal).toBeGreaterThan(0);
    expect(alphaCell.subtotal).toBeCloseTo(5000, 2);
    // Tax: 18% percentage mode => 900 on a 5000 base.
    expect(alphaCell.tax_pct).toBe(18);
    expect(alphaCell.tax_amt).toBeGreaterThan(0);
    expect(alphaCell.tax_amt).toBeCloseTo(900, 2);
    // The new charge breakdown keys are arrays.
    expect(Array.isArray(alphaCell.other_charges)).toBe(true);
    expect(Array.isArray(alphaCell.global_charges)).toBe(true);

    // beta didn't quote product A -> explicit null cell.
    expect(productA.quotes[String(IDS.users.vendor_beta)]).toBeNull();
  });
});

// ===========================================================================
// 3) State — open: no finalization/approval.
// ===========================================================================
describe("GET /rfq/quote-comparison-view/:id — state 'open'", () => {
  it("a product with no finalization and no approval is 'open' with finalized_vendor null", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    expect(res.status).toBe(200);

    const product = res.body.products[0];
    expect(product.state).toBe("open");
    expect(product.finalized_vendor).toBeNull();
    expect(product.reject_info).toBeNull();
  });
});

// ===========================================================================
// 4) State — pending: finalization + PENDING NEGOTIATION_QUOTE instance.
// ===========================================================================
describe("GET /rfq/quote-comparison-view/:id — state 'pending'", () => {
  it("finalized product + PENDING approval -> 'pending' with finalized_vendor set", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id, product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    const qid = await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });
    await finalizeProduct(rfq_id, rfq_no, qid, product_variant_id, IDS.users.vendor_alpha);
    await makeQuoteApproval({ rfq_product_id, status: "PENDING" });

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    expect(res.status).toBe(200);

    const product = res.body.products.find((p) => p.id === rfq_product_id);
    expect(product.state).toBe("pending");
    expect(product.finalized_vendor).toBe(IDS.users.vendor_alpha);
    expect(product.reject_info).toBeNull();

    // The approval_chain reflects the raised instance's resolved step approver.
    expect(res.body.approval_chain.length).toBeGreaterThanOrEqual(1);
    expect(res.body.approval_chain[0]).toHaveProperty("num");
    expect(res.body.approval_chain[0]).toHaveProperty("you");

    // Per-product approval drawer payload: current approvers + audit trail.
    expect(product.approval).toBeDefined();
    expect(Array.isArray(product.approval.current_approvers)).toBe(true);
    expect(product.approval.current_approvers.length).toBe(1);
    expect(product.approval.current_approvers[0]).toHaveProperty("name");
    expect(product.approval.current_approvers[0]).toHaveProperty("initials");
    // Trail: leading "Sent for approval" (done) + the current pending L1 step.
    const trail = product.approval.trail;
    expect(Array.isArray(trail)).toBe(true);
    expect(trail[0].title).toBe("Sent for approval");
    expect(trail[0].status).toBe("done");
    const l1 = trail.find((n) => n.title === "L1 approval");
    expect(l1).toBeDefined();
    expect(l1.status).toBe("current");
    // Terminal node makes the chain end explicit while still pending.
    const last = trail[trail.length - 1];
    expect(last.kind).toBe("terminal");
    expect(last.status).toBe("pending");
    expect(last.title).toBe("Forwarded to the next stage");
  });

  // Same defect family as po.dashboard.test.js's REMOVED-tombstone suite, but
  // with an important split: approval_chain (fetchApprovalChain) is a
  // count/name SUMMARY, so a REMOVED approver must not inflate its "N
  // approvers" label or be picked as the named approver. The trail's
  // per-step `approvers` list is a different contract: QuoteComparison.js's
  // renderApprovalDrawer already splits it into activeApprovers (status !==
  // 'REMOVED') and removedApprovers (status === 'REMOVED') and renders the
  // latter muted/struck-through with the removal reason + date — so this
  // array must KEEP carrying REMOVED rows (with removal_reason/removed_at),
  // same "pass through, let the frontend distinguish" contract as the RFQ
  // lifecycle payload. Filtering it out here would silently drop the
  // drawer's removed-approver block.
  it("approval_chain excludes a REMOVED approver from its count/name, but the trail's approvers list still carries it with removal_reason + removed_at", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id, product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    const qid = await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });
    await finalizeProduct(rfq_id, rfq_no, qid, product_variant_id, IDS.users.vendor_alpha);
    const instId = await makeQuoteApproval({ rfq_product_id, status: "PENDING" });

    // Tombstone a second approver on the same step.
    const step = await db.one(
      `SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = $1 AND step_order = 1`,
      [instId]
    );
    const removed = await db.one(
      `INSERT INTO tbl_approval_step_approvers
         (approval_instance_step_id, approver_user_id, status, removed_at, removal_reason)
       VALUES ($1, $2, 'REMOVED', NOW(), 'role_removed') RETURNING id`,
      [step.id, IDS.users.a1_proc_finance]
    );
    inserted.approverIds.push(removed.id);

    const removedName = (await db.one(`SELECT name FROM tbl_users WHERE id=$1`, [IDS.users.a1_proc_finance])).name;

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    expect(res.status).toBe(200);

    // approval_chain: only the one live approver remains -> never "2 approvers".
    expect(res.body.approval_chain[0].name).not.toMatch(/approvers$/);
    expect(res.body.approval_chain[0].name).not.toBe(removedName);

    const product = res.body.products.find((p) => p.id === rfq_product_id);
    const l1 = product.approval.trail.find((n) => n.title === "L1 approval");
    expect(l1).toBeDefined();
    // The trail's `by` (single actor) is never the tombstone...
    expect(l1.by).not.toBe(removedName);
    // ...but the full approvers list still carries it, labelled.
    const removedEntry = (l1.approvers || []).find((a) => a.name === removedName);
    expect(removedEntry).toBeDefined();
    expect(removedEntry.status).toBe("REMOVED");
    expect(removedEntry.removal_reason).toBe("role_removed");
    expect(removedEntry.removed_at).toBeTruthy();
  });
});

// ===========================================================================
// 5) State — rejected (+ reject_info) and approved.
// ===========================================================================
describe("GET /rfq/quote-comparison-view/:id — state 'rejected' / 'approved'", () => {
  it("finalized product + REJECTED approval with a REJECT comment -> 'rejected' + reject_info", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id, product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    const qid = await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });
    await finalizeProduct(rfq_id, rfq_no, qid, product_variant_id, IDS.users.vendor_alpha);
    await makeQuoteApproval({
      rfq_product_id, status: "REJECTED",
      approverUserId: IDS.users.a1_proc_commApp, reason: "price exceeds target",
    });
    const approverName = (await db.one(`SELECT name FROM tbl_users WHERE id=$1`, [IDS.users.a1_proc_commApp])).name;

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    expect(res.status).toBe(200);

    const product = res.body.products.find((p) => p.id === rfq_product_id);
    expect(product.state).toBe("rejected");
    expect(product.finalized_vendor).toBe(IDS.users.vendor_alpha);
    expect(product.reject_info).not.toBeNull();
    expect(product.reject_info.by).toBe(approverName);
    expect(product.reject_info.reason).toBe("price exceeds target");

    // The approval trail surfaces the rejected node with the actor + reason.
    const rej = product.approval.trail.find((n) => n.status === "rejected");
    expect(rej).toBeDefined();
    expect(rej.by).toBe(approverName);
    expect(rej.reason).toBe("price exceeds target");
    // No "forwarded / complete" terminal node on a rejection.
    expect(product.approval.trail.some((n) => n.kind === "terminal")).toBe(false);
  });

  it("finalized product + APPROVED approval -> 'approved' with reject_info null", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id, product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    const qid = await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });
    await finalizeProduct(rfq_id, rfq_no, qid, product_variant_id, IDS.users.vendor_alpha);
    await makeQuoteApproval({ rfq_product_id, status: "APPROVED" });

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    expect(res.status).toBe(200);

    const product = res.body.products.find((p) => p.id === rfq_product_id);
    expect(product.state).toBe("approved");
    expect(product.finalized_vendor).toBe(IDS.users.vendor_alpha);
    expect(product.reject_info).toBeNull();
    // Terminal "Approval complete → forwarded" node once fully approved.
    const last = product.approval.trail[product.approval.trail.length - 1];
    expect(last.kind).toBe("terminal");
    expect(last.status).toBe("done");
    expect(last.title).toBe("Approval complete");
  });
});

// ===========================================================================
// 6) Delivery-charge toggle — ?freight=0 must actually remove delivery charges.
// ===========================================================================
// This suite previously asserted only `noFreight.total <= landed.total`, which
// passes on IDENTICAL values — and they were identical, because the flag was
// dead: getQuoteComparisonView forwarded it to getQuotesByRfqById2, which
// declared `no_freight` and never read it. That permissive assertion is why the
// broken toggle shipped. Every assertion here is now strict.
describe("GET /rfq/quote-comparison-view/:id — delivery-charge toggle", () => {
  const cellOf = (res) => res.body.products[0].quotes[String(IDS.users.vendor_alpha)];

  async function seedRfq(otherCharges) {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges, productVariantId: product_variant_id,
    });
    return rfq_id;
  }

  it("removes the delivery charge from the total, leaving base and tax untouched", async () => {
    const rfq_id = await seedRfq(FREIGHT_CHARGE);
    const client = await scopedClient(IDS.users.a1_proc_buyer);

    const landed = await client.get(VIEW(rfq_id));
    const exDelivery = await client.get(`${VIEW(rfq_id)}?freight=0`);
    expect(landed.status).toBe(200);
    expect(exDelivery.status).toBe(200);

    const a = cellOf(landed);
    const b = cellOf(exDelivery);

    expect(a.delivery_charges).toBeGreaterThan(0);
    // STRICTLY less — not `<=`.
    expect(b.total).toBeLessThan(a.total);
    // Only delivery-class charges come off; the pre-charge figures are stable.
    expect(b.base).toBe(a.base);
    expect(b.subtotal).toBe(a.subtotal);
    expect(b.tax_amt).toBe(a.tax_amt);
    expect(a.total - b.total).toBeCloseTo(a.delivery_charges, 2);
  });

  it("removes loading/unloading and transportation too, but keeps packaging and insurance", async () => {
    // The old chargeSubtotal(engine,'freight') matched ONLY the literal freight
    // slug, so these two logistics charges stayed silently inside the price.
    const rfq_id = await seedRfq([
      { name: "Freight", slug: "freight", amount: 100, amount_mode: "absolute", tax: 0, tax_mode: "percentage", comment: "" },
      { name: "Loading/Unloading", slug: "loading_unloading", amount: 50, amount_mode: "absolute", tax: 0, tax_mode: "percentage", comment: "" },
      { name: "Transportation", slug: "transportation_charges", amount: 25, amount_mode: "absolute", tax: 0, tax_mode: "percentage", comment: "" },
      { name: "Packaging", slug: "packaging", amount: 10, amount_mode: "absolute", tax: 0, tax_mode: "percentage", comment: "" },
      { name: "Insurance", slug: "insurance", amount: 5, amount_mode: "absolute", tax: 0, tax_mode: "percentage", comment: "" },
    ]);
    const client = await scopedClient(IDS.users.a1_proc_buyer);

    const a = cellOf(await client.get(VIEW(rfq_id)));
    const b = cellOf(await client.get(`${VIEW(rfq_id)}?freight=0`));

    expect(a.delivery_charges).toBeCloseTo(175, 2);
    expect(a.total - b.total).toBeCloseTo(175, 2);
  });

  it("also STRIPS the delivery entries from other_charges when excluded", async () => {
    // Load-bearing for the client. Every frontend helper re-derives figures by
    // summing other_charges — the price, the vendor grand total, the L1
    // roll-up, the rank basis, the savings KPI, the category subtotals. If the
    // entries survived here, `total` and those derived figures would disagree
    // and the toggle would appear to work in some places and not others.
    const rfq_id = await seedRfq([
      { name: "Freight", slug: "freight", amount: 100, amount_mode: "absolute", tax: 0, tax_mode: "percentage", comment: "" },
      { name: "Packaging", slug: "packaging", amount: 10, amount_mode: "absolute", tax: 0, tax_mode: "percentage", comment: "" },
    ]);
    const client = await scopedClient(IDS.users.a1_proc_buyer);

    const a = cellOf(await client.get(VIEW(rfq_id)));
    const b = cellOf(await client.get(`${VIEW(rfq_id)}?freight=0`));

    expect(a.other_charges.map((c) => c.label)).toEqual(expect.arrayContaining(["Freight", "Packaging"]));
    expect(b.other_charges.map((c) => c.label)).not.toContain("Freight");
    expect(b.other_charges.map((c) => c.label)).toContain("Packaging");

    // And the cell stays internally consistent: subtotal + tax + remaining
    // charges reconciles to the reported total.
    const remaining = b.other_charges.reduce((s, c) => s + c.amount, 0);
    expect(b.subtotal + b.tax_amt + remaining).toBeCloseTo(b.total, 2);
  });

  it("counts a QUOTE-LEVEL transportation charge as delivery too", async () => {
    // 16 production quotes carry { slug:'transportation', is_global:true } worth
    // 0.6%-26% of the quote, and NONE of them has a line-level delivery charge.
    // Classifying only line charges hid the toggle entirely on 9 RFQs while the
    // charge sat silently inside the price, and on 7 more moved every column
    // except the one that actually had the charge.
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    const quote_id = await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, productVariantId: product_variant_id,
    });
    await db.none(
      `UPDATE tbl_quotes SET global_charges = $2::jsonb WHERE id = $1`,
      [quote_id, JSON.stringify([
        { slug: "transportation", name: "Transportation", amount: 300, amount_mode: "absolute", is_global: true },
      ])]
    );

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const withAll = await client.get(VIEW(rfq_id));
    const exDelivery = await client.get(`${VIEW(rfq_id)}?freight=0`);

    expect(withAll.body.has_delivery_charges).toBe(true);
    const a = cellOf(withAll);
    const b = cellOf(exDelivery);
    expect(a.delivery_charges).toBeGreaterThan(0);
    expect(b.total).toBeLessThan(a.total);
    // And the entry itself is gone from the roll-up the client sums.
    expect(b.global_charges.map((c) => c.label)).not.toContain("Transportation");
  });

  it("reports has_delivery_charges true when a cell carries one, false when none do", async () => {
    const client = await scopedClient(IDS.users.a1_proc_buyer);

    const withFreight = await client.get(VIEW(await seedRfq(FREIGHT_CHARGE)));
    expect(withFreight.body.has_delivery_charges).toBe(true);

    const without = await client.get(VIEW(await seedRfq([])));
    expect(without.body.has_delivery_charges).toBe(false);
  });

  it("accepts 1/0 and true/false for the freight param", async () => {
    const rfq_id = await seedRfq(FREIGHT_CHARGE);
    const client = await scopedClient(IDS.users.a1_proc_buyer);

    for (const [on, off] of [["1", "0"], ["true", "false"]]) {
      const a = cellOf(await client.get(`${VIEW(rfq_id)}?freight=${on}`));
      const b = cellOf(await client.get(`${VIEW(rfq_id)}?freight=${off}`));
      expect(b.total).toBeLessThan(a.total);
    }
  });
});

// ===========================================================================
// 6b) Finalizer identity — "who awarded this" must reach the cell.
// ===========================================================================
// The client could not tell an awarded cell from a merely-cheapest one. Half of
// that is colour, half is that the payload never carried WHO finalized: the
// name is fetched by getQuotesByRfqById2 (as finalization.finilized_by, sic)
// and discarded, and fetchFinalizations re-queried the table without
// created_by. tbl_quote_finalization.created_by is populated on 100% of 1,672
// production rows, so this needs no migration and no backfill.
describe("GET /rfq/quote-comparison-view/:id — finalizer identity", () => {
  it("exposes the finalizer's name on a finalized product", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    const quote_id = await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, productVariantId: product_variant_id,
    });
    await finalizeProduct(rfq_id, rfq_no, quote_id, product_variant_id, IDS.users.vendor_alpha);

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    const p = res.body.products[0];

    expect(p.finalized_vendor).toBe(IDS.users.vendor_alpha);
    expect(p.finalized_by).toBeTruthy();
    expect(typeof p.finalized_by.name).toBe("string");
    expect(p.finalized_by.name.length).toBeGreaterThan(0);
    expect(p.finalized_by.at).toEqual(expect.any(String));
  });

  it("returns finalized_by null for a product that was never finalized", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, productVariantId: product_variant_id,
    });

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const p = (await client.get(VIEW(rfq_id))).body.products[0];

    expect(p.finalized_vendor).toBeNull();
    expect(p.finalized_by).toBeNull();
  });
});

// ===========================================================================
// 7) SECURITY — cross-tenant isolation (the most important test).
// ===========================================================================
describe("GET /rfq/quote-comparison-view/:id — SECURITY: tenant isolation", () => {
  it("a company-B buyer gets 404 on a company-A RFQ's view; the in-scope A buyer gets 200", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq({ hospitality: IDS.hospitality.A }); // company A RFQ
    const { product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });

    // companyB_admin scoped to hospitality B -> the A RFQ is out of scope -> 404.
    const bClient = await scopedClient(IDS.users.companyB_admin, IDS.hospitality.B);
    const denied = await bClient.get(VIEW(rfq_id));
    expect(denied.status).toBe(404);
    expect(denied.body.status).toBe(2);
    // No leak: the contract object is not returned.
    expect(denied.body.products).toBeUndefined();
    expect(denied.body.vendors).toBeUndefined();

    // Sanity: the in-scope A buyer DOES see it (proves the RFQ exists + isolation is real).
    const aClient = await scopedClient(IDS.users.a1_proc_buyer, IDS.hospitality.A);
    const allowed = await aClient.get(VIEW(rfq_id));
    expect(allowed.status).toBe(200);
    expect(allowed.body.rfq.number).toBe(String(rfq_no));
  });
});

// ===========================================================================
// 8) Role gate — vendors (user_type=3) are blocked by noAcl([3]).
// ===========================================================================
describe("GET /rfq/quote-comparison-view/:id — role gate noAcl([3])", () => {
  it("a vendor user (user_type=3) gets 403", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });

    // Fixture vendor users have user_type NULL; the route gate keys off
    // user_type === 3. Set it for the duration of this test, then restore.
    const prev = await db.one(`SELECT user_type FROM tbl_users WHERE id=$1`, [IDS.users.vendor_alpha]);
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id=$1`, [IDS.users.vendor_alpha]);
    try {
      const client = await scopedClient(IDS.users.vendor_alpha);
      const res = await client.get(VIEW(rfq_id));
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/Access denied/i);
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id=$1`, [IDS.users.vendor_alpha, prev.user_type]);
    }
  });
});

// ===========================================================================
// awaiting_me + LPR grand-total fields
// ===========================================================================
describe("GET /rfq/quote-comparison-view/:id — awaiting_me + LPR fields", () => {
  it("awaiting_me is true for the pending product's current approver and false for others", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id, product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    const qid = await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });
    await finalizeProduct(rfq_id, rfq_no, qid, product_variant_id, IDS.users.vendor_alpha);
    // PENDING quote approval whose current pending step approver is the comm approver.
    await makeQuoteApproval({ rfq_product_id, status: "PENDING", approverUserId: IDS.users.a1_proc_commApp });

    // The assigned approver: awaiting_me true.
    const approver = await scopedClient(IDS.users.a1_proc_commApp);
    const ar = await approver.get(VIEW(rfq_id));
    expect(ar.status).toBe(200);
    const ap = ar.body.products.find((p) => p.id === rfq_product_id);
    expect(ap.awaiting_me).toBe(true);

    // An in-scope non-approver: awaiting_me false (drives evaluator vs approver view).
    const buyer = await scopedClient(IDS.users.a1_proc_buyer);
    const br = await buyer.get(VIEW(rfq_id));
    const bp = br.body.products.find((p) => p.id === rfq_product_id);
    expect(bp.awaiting_me).toBe(false);
  });

  it("lpr exposes the all-in grand-total basis keys (landed_unit / total / qty)", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id, product_variant_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, IDS.users.vendor_alpha, {
      unitPrice: 500, quantity: 10, tax: 18, otherCharges: FREIGHT_CHARGE, productVariantId: product_variant_id,
    });

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const res = await client.get(VIEW(rfq_id));
    expect(res.status).toBe(200);
    const product = res.body.products.find((p) => p.id === rfq_product_id);
    expect(product.lpr).toHaveProperty("landed_unit");
    expect(product.lpr).toHaveProperty("total");
    expect(product.lpr).toHaveProperty("qty");
    // landed_unit, when present, is total/qty (all-in per unit); else null.
    if (product.lpr.landed_unit != null) {
      expect(typeof product.lpr.landed_unit).toBe("number");
    }
  });
});
