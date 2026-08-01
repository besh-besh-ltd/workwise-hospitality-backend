// Security regression suite for the vendor quote-update endpoint
// `PUT /api/v1/rfq/quote/update/:quoteId` (rfqController.updateQuoteItems).
//
// Four defects are locked in here. Every one of them is money-critical: this
// endpoint is how a vendor states the price a buyer will award a PO against.
//
//   FIX 1 — SQL injection. `:quoteId` had no validation and was interpolated
//           straight into `rfqModel.checkIfExists`, whose implementation is
//           `SELECT * FROM ${table} WHERE ${parameter}` with NO placeholders.
//           pg-promise formats client-side and hands Postgres a single text
//           statement, so a `;` in the parameter runs a SECOND statement.
//
//   FIX 2 — IDOR. The quote was loaded by id and never checked against the
//           caller; `created_by` was read only to preserve it on write. Any
//           vendor could rewrite any other vendor's prices.
//
//   FIX 3 — No server-side field restriction during a negotiation. The buyer
//           picks exactly which fields are negotiable
//           (`tbl_negotiation_rounds.vendor_approvals[].negotiation_fields[]`,
//           and `products[].vendor_targets[].fields[]` for multi-product
//           rounds). That list was never used as a write allowlist — the only
//           check was per-PRODUCT ("is this product in an active round?").
//
//   FIX 4 — Negotiation-round quote writes were fire-and-forget: wrapped in
//           `try/catch → logError` and skipped entirely when a row already
//           existed. A vendor could revise their price and have nothing at all
//           reach the negotiation round, with no user-visible signal.
//
// Per CONVENTIONS.md §3 these run over real HTTP through the full middleware
// chain (auth → subscription → controller) against local Postgres.

import { describe, it, expect, afterAll, beforeEach, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { makeRFQ } from "../factories/rfq.js";
import rfqModel from "../../app/models/rfqModel.js";
import pricingEngine from "../../app/services/pricingEngine.js";

const VENDOR_A = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;

afterAll(async () => {
  await closeDb();
});

const inserted = { rfqIds: [] };

beforeEach(() => {
  inserted.rfqIds = [];
});

afterEach(async () => {
  if (!inserted.rfqIds.length) return;
  await db.none(
    `DELETE FROM tbl_negotiation_round_quotes
      WHERE negotiation_round_id IN (SELECT id FROM tbl_negotiation_rounds WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(`DELETE FROM tbl_negotiation_rounds WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(
    `DELETE FROM tbl_quote_item_history
      WHERE quote_item_id IN (SELECT id FROM tbl_quote_items WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_quote_item_files
      WHERE quote_item_id IN (SELECT id FROM tbl_quote_items WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(
    `DELETE FROM tbl_quotes_files WHERE quote_id IN (SELECT id FROM tbl_quotes WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_quotes_payment_terms
      WHERE quote_id IN (SELECT id FROM tbl_quotes WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_quote_activity WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
});

// ---- fixtures -------------------------------------------------------------

const ts = (msFromNow) =>
  new Date(Date.now() + msFromNow).toISOString().replace("T", " ").slice(0, 19);

/** Published RFQ with an OPEN bid window and both vendors mapped to it. */
async function makeOpenRfq({ variantIds = [1], vendors = [VENDOR_A] } = {}) {
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    tender_publish_date: ts(-86400_000),
    vendor_clarification_date: ts(-3600_000),
    bid_end_date: ts(5 * 86400_000),
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);

  for (const vid of variantIds) {
    await db.none(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0)`,
      [rfq_id, vid]
    );
    for (const uid of vendors) {
      await db.none(
        `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
         VALUES ($1, $2, $3, 0)`,
        [rfq_id, vid, uid]
      );
    }
  }
  return { rfq_id, rfq_no };
}

function productPayload(overrides = {}) {
  return {
    product_id: 1,
    variant: 0,
    unit_price: 500,
    tax: 18,
    tax_mode: "percentage",
    total_price: 5900,
    comment: "",
    delivery_period: "7",
    quantity: "10",
    other_charges: [],
    document_files: [],
    ...overrides,
  };
}

const FREIGHT = (amount) => ({
  name: "Freight",
  slug: "freight",
  amount,
  amount_mode: "absolute",
  tax: 0,
  tax_mode: "absolute",
  comment: "trucking",
});

/**
 * Seed an already-submitted quote (prerequisite data, CONVENTIONS.md §1 —
 * the function under test is `updateQuoteItems`, not `createQuote`). The
 * stored totals come from the production pricing engine so they match exactly
 * what a real submission would have written.
 *
 * `createQuote` cannot be used here: it gates on `user_type in (3,4)` and the
 * shared fixture users deliberately leave `tbl_users.user_type` NULL.
 */
async function seedQuote(userId, rfq_id, rfq_no, products) {
  const quote = await db.one(
    `INSERT INTO tbl_quotes
       (rfq_id, rfq_no, status, created_by, updated_by, is_regret, global_payment_term,
        global_comment, global_charges, pricing_method)
     VALUES ($1, $2, 1, $3, $3, 0, 'Net 30', '', '[]'::jsonb, 'TRADITIONAL')
     RETURNING id`,
    [rfq_id, rfq_no, userId]
  );
  for (const p of products) {
    const engine = pricingEngine.calculateLineTotal({
      unit_price: p.unit_price,
      quantity: p.quantity,
      tax: p.tax,
      tax_mode: p.tax_mode,
      other_charges: p.other_charges || [],
    });
    await db.none(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, tax, total_price,
          comment, delivery_period, quantity, variant, tax_mode, other_charges, pricing_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,'TRADITIONAL')`,
      [
        rfq_id, rfq_no, quote.id, p.product_id, p.unit_price, p.tax, engine.total,
        p.comment, p.delivery_period, p.quantity, p.variant, p.tax_mode,
        JSON.stringify(p.other_charges || []),
      ]
    );
  }
  return quote.id;
}

function updateBody(rfq_id, rfq_no, products, overrides = {}) {
  return {
    rfq_id,
    rfq_no,
    products,
    globalPaymentTerms: "Net 30",
    globalComment: "",
    global_payment_term_list: { createdTerms: [], updatedTerms: [], deletedTerms: [] },
    global_charges: [],
    ...overrides,
  };
}

async function putQuote(userId, quoteId, body) {
  const client = await httpClient(userId);
  return client.put(`/api/v1/rfq/quote/update/${quoteId}`).send(body);
}

/** Active negotiation round (legacy single-product shape) opening `fields`. */
async function makeActiveRound(rfq_id, rfqProductId, vendorId, fields) {
  const row = await db.one(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, round_number, end_date, status, created_by, source_type, source_id,
        rfq_product_id, vendor_ids, vendor_approvals)
     VALUES ($1, 1, NOW() + interval '2 days', 'ACTIVE', $2, 'RFQ', $1, $3, $4::int[], $5::jsonb)
     RETURNING id`,
    [
      rfq_id,
      IDS.users.a1_proc_buyer,
      rfqProductId,
      [vendorId],
      JSON.stringify([
        { vendor_id: vendorId, negotiation_fields: fields.map((f) => ({ name: f, target: 1 })) },
      ]),
    ]
  );
  return row.id;
}

async function rfqProductId(rfq_id, variantId) {
  const r = await db.one(
    `SELECT id FROM tbl_rfq_products WHERE rfq_id = $1 AND product_variant_id = $2 AND variant = 0`,
    [rfq_id, variantId]
  );
  return r.id;
}

// ===========================================================================
//  FIX 1 — SQL injection
// ===========================================================================

describe("FIX 1 — SQL injection on PUT /rfq/quote/update/:quoteId", () => {
  it("checkIfExists: an interpolated value cannot smuggle a second statement", async () => {
    await db.none(`DROP TABLE IF EXISTS tbl_sqli_canary`);
    await db.none(`CREATE TABLE tbl_sqli_canary (id int)`);
    try {
      // Exactly the string rfqController built pre-fix:
      //   `id = '${quoteId}'`  with quoteId taken raw from req.params.
      const quoteId = `1'; DROP TABLE tbl_sqli_canary; --`;
      await expect(
        rfqModel.checkIfExists("tbl_quotes", `id = '${quoteId}'`)
      ).rejects.toThrow();

      const canary = await db.one(`SELECT to_regclass('public.tbl_sqli_canary') AS t`);
      expect(canary.t).not.toBeNull();
    } finally {
      await db.none(`DROP TABLE IF EXISTS tbl_sqli_canary`);
    }
  });

  it("checkIfExists rejects a non-identifier table name", async () => {
    await expect(
      rfqModel.checkIfExists("tbl_quotes; DROP TABLE x", `id = 1`)
    ).rejects.toThrow(/table/i);
  });

  it("checkIfExists supports a parameterized condition and returns the right row", async () => {
    const { rfq_id, rfq_no } = await makeOpenRfq();
    const quoteId = await seedQuote(VENDOR_A, rfq_id, rfq_no, [productPayload()]);

    const rows = await rfqModel.checkIfExists("tbl_quotes", {
      where: "id = $1",
      values: [quoteId],
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].id)).toBe(Number(quoteId));

    // A crafted value stays a VALUE — it cannot become boolean logic.
    const evil = await rfqModel.checkIfExists("tbl_quotes", {
      where: "id::text = $1",
      values: ["1' OR '1'='1"],
    });
    expect(evil).toHaveLength(0);
  });

  it("a crafted :quoteId is rejected at the route and mutates nothing", async () => {
    const { rfq_id, rfq_no } = await makeOpenRfq();
    const quoteId = await seedQuote(VENDOR_A, rfq_id, rfq_no, [productPayload()]);
    const before = await db.one(`SELECT global_payment_term FROM tbl_quotes WHERE id = $1`, [quoteId]);

    for (const evil of ["1 OR 1=1", "1' OR '1'='1", "1; SELECT 1", "-1", "abc"]) {
      const res = await putQuote(
        VENDOR_A,
        encodeURIComponent(evil),
        updateBody(rfq_id, rfq_no, [productPayload({ unit_price: 999 })], {
          globalPaymentTerms: "HACKED",
        })
      );
      expect(res.status).toBe(400);
    }

    const after = await db.one(
      `SELECT q.global_payment_term, i.unit_price
         FROM tbl_quotes q JOIN tbl_quote_items i ON i.quote_id = q.id
        WHERE q.id = $1`,
      [quoteId]
    );
    expect(after.global_payment_term).toBe(before.global_payment_term);
    expect(Number(after.unit_price)).toBe(500);
  });

  it("a valid numeric :quoteId still updates the quote", async () => {
    const { rfq_id, rfq_no } = await makeOpenRfq();
    const quoteId = await seedQuote(VENDOR_A, rfq_id, rfq_no, [productPayload()]);

    const res = await putQuote(
      VENDOR_A,
      quoteId,
      updateBody(rfq_id, rfq_no, [productPayload({ unit_price: 600 })])
    );
    expect(res.status).toBe(200);

    const item = await db.one(`SELECT unit_price FROM tbl_quote_items WHERE quote_id = $1`, [quoteId]);
    expect(Number(item.unit_price)).toBe(600);
  });
});

// ===========================================================================
//  FIX 2 — IDOR
// ===========================================================================

describe("FIX 2 — quote ownership", () => {
  it("vendor B cannot update vendor A's quote; vendor A still can", async () => {
    const { rfq_id, rfq_no } = await makeOpenRfq({ vendors: [VENDOR_A, VENDOR_B] });
    const quoteA = await seedQuote(VENDOR_A, rfq_id, rfq_no, [productPayload({ unit_price: 500 })]);

    const attack = await putQuote(
      VENDOR_B,
      quoteA,
      updateBody(rfq_id, rfq_no, [productPayload({ unit_price: 1 })])
    );
    expect(attack.status).toBe(403);

    const untouched = await db.one(`SELECT unit_price FROM tbl_quote_items WHERE quote_id = $1`, [quoteA]);
    expect(Number(untouched.unit_price)).toBe(500);

    const legit = await putQuote(
      VENDOR_A,
      quoteA,
      updateBody(rfq_id, rfq_no, [productPayload({ unit_price: 450 })])
    );
    expect(legit.status).toBe(200);
    const changed = await db.one(`SELECT unit_price FROM tbl_quote_items WHERE quote_id = $1`, [quoteA]);
    expect(Number(changed.unit_price)).toBe(450);
  });
});

// ===========================================================================
//  FIX 3 — negotiation field allowlist
// ===========================================================================

describe("FIX 3 — server-side negotiation field restriction", () => {
  it("a round opening only `freight` refuses a unit_price change but accepts the freight change", async () => {
    const { rfq_id, rfq_no } = await makeOpenRfq({ variantIds: [1] });
    const quoteId = await seedQuote(VENDOR_A, rfq_id, rfq_no, [
      productPayload({ unit_price: 500, other_charges: [FREIGHT(100)] }),
    ]);
    await makeActiveRound(rfq_id, await rfqProductId(rfq_id, 1), VENDOR_A, ["freight"]);

    // (a) price change on a product under the round → refused.
    const refused = await putQuote(
      VENDOR_A,
      quoteId,
      updateBody(rfq_id, rfq_no, [
        productPayload({ unit_price: 400, other_charges: [FREIGHT(100)] }),
      ])
    );
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/base_price/);

    const stillOriginal = await db.one(
      `SELECT unit_price, other_charges FROM tbl_quote_items WHERE quote_id = $1`,
      [quoteId]
    );
    expect(Number(stillOriginal.unit_price)).toBe(500);

    // (b) the field the buyer DID open goes through.
    const allowed = await putQuote(
      VENDOR_A,
      quoteId,
      updateBody(rfq_id, rfq_no, [
        productPayload({ unit_price: 500, other_charges: [FREIGHT(60)] }),
      ])
    );
    expect(allowed.status).toBe(200);

    const after = await db.one(
      `SELECT unit_price, other_charges FROM tbl_quote_items WHERE quote_id = $1`,
      [quoteId]
    );
    expect(Number(after.unit_price)).toBe(500);
    const charges = Array.isArray(after.other_charges)
      ? after.other_charges
      : JSON.parse(after.other_charges);
    expect(Number(charges.find((c) => c.slug === "freight").amount)).toBe(60);
  });

  it("global payment terms cannot be rewritten under a round that did not open them", async () => {
    const { rfq_id, rfq_no } = await makeOpenRfq({ variantIds: [1] });
    const quoteId = await seedQuote(VENDOR_A, rfq_id, rfq_no, [productPayload({ unit_price: 500 })]);
    await makeActiveRound(rfq_id, await rfqProductId(rfq_id, 1), VENDOR_A, ["freight"]);

    const res = await putQuote(
      VENDOR_A,
      quoteId,
      updateBody(rfq_id, rfq_no, [productPayload({ unit_price: 500 })], {
        globalPaymentTerms: "100% advance",
      })
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/payment_terms/);

    const q = await db.one(`SELECT global_payment_term FROM tbl_quotes WHERE id = $1`, [quoteId]);
    expect(q.global_payment_term).toBe("Net 30");
  });

  it("a product NOT under an active round stays fully editable", async () => {
    const { rfq_id, rfq_no } = await makeOpenRfq({ variantIds: [1, 2] });
    const quoteId = await seedQuote(VENDOR_A, rfq_id, rfq_no, [
      productPayload({ product_id: 1, unit_price: 500 }),
      productPayload({ product_id: 2, unit_price: 700 }),
    ]);
    // Round covers variant 1 only.
    await makeActiveRound(rfq_id, await rfqProductId(rfq_id, 1), VENDOR_A, ["freight"]);

    const res = await putQuote(
      VENDOR_A,
      quoteId,
      updateBody(rfq_id, rfq_no, [
        productPayload({ product_id: 1, unit_price: 500 }),
        productPayload({ product_id: 2, unit_price: 650, comment: "revised" }),
      ])
    );
    expect(res.status).toBe(200);

    const rows = await db.any(
      `SELECT product_variant_id, unit_price FROM tbl_quote_items WHERE quote_id = $1 ORDER BY product_variant_id`,
      [quoteId]
    );
    expect(Number(rows.find((r) => r.product_variant_id === 1).unit_price)).toBe(500);
    expect(Number(rows.find((r) => r.product_variant_id === 2).unit_price)).toBe(650);
  });

  it("with no negotiation round at all the quote is fully editable (normal path unaffected)", async () => {
    const { rfq_id, rfq_no } = await makeOpenRfq({ variantIds: [1] });
    const quoteId = await seedQuote(VENDOR_A, rfq_id, rfq_no, [productPayload({ unit_price: 500 })]);

    const res = await putQuote(
      VENDOR_A,
      quoteId,
      updateBody(rfq_id, rfq_no, [
        productPayload({ unit_price: 321, tax: 12, other_charges: [FREIGHT(75)], comment: "new" }),
      ], { globalPaymentTerms: "50% advance", globalComment: "please consider" })
    );
    expect(res.status).toBe(200);

    const item = await db.one(`SELECT unit_price, tax FROM tbl_quote_items WHERE quote_id = $1`, [quoteId]);
    expect(Number(item.unit_price)).toBe(321);
    expect(Number(item.tax)).toBe(12);
  });
});

// ===========================================================================
//  FIX 4 — negotiation-round quote writes must not fail silently
// ===========================================================================

describe("FIX 4 — negotiation round quote persistence", () => {
  it("a revised price under an active round updates the round quote instead of being dropped", async () => {
    const { rfq_id, rfq_no } = await makeOpenRfq({ variantIds: [1] });
    const quoteId = await seedQuote(VENDOR_A, rfq_id, rfq_no, [productPayload({ unit_price: 500 })]);
    const rp = await rfqProductId(rfq_id, 1);
    const roundId = await makeActiveRound(rfq_id, rp, VENDOR_A, ["base_price"]);

    const first = await putQuote(
      VENDOR_A,
      quoteId,
      updateBody(rfq_id, rfq_no, [productPayload({ unit_price: 450 })])
    );
    expect(first.status).toBe(200);

    const second = await putQuote(
      VENDOR_A,
      quoteId,
      updateBody(rfq_id, rfq_no, [productPayload({ unit_price: 400 })])
    );
    expect(second.status).toBe(200);

    const rows = await db.any(
      `SELECT quoted_price, previous_price FROM tbl_negotiation_round_quotes
        WHERE negotiation_round_id = $1 AND vendor_id = $2 AND rfq_product_id = $3`,
      [roundId, VENDOR_A, rp]
    );
    expect(rows).toHaveLength(1);
    // 400 x 10 x 1.18 = 4720 — the LATEST revision, not the first.
    expect(Number(rows[0].quoted_price)).toBeCloseTo(4720, 2);
    // Baseline stays the pre-round landed total (500 x 10 x 1.18 = 5900).
    expect(Number(rows[0].previous_price)).toBeCloseTo(5900, 2);
  });

  it("a failed negotiation-round write is surfaced to the caller instead of swallowed", async () => {
    const { rfq_id, rfq_no } = await makeOpenRfq({ variantIds: [1] });
    const quoteId = await seedQuote(VENDOR_A, rfq_id, rfq_no, [productPayload({ unit_price: 500 })]);
    const rp = await rfqProductId(rfq_id, 1);
    await makeActiveRound(rfq_id, rp, VENDOR_A, ["base_price"]);

    await db.none(`
      CREATE OR REPLACE FUNCTION tbl_nrq_boom() RETURNS trigger AS $fn$
      BEGIN RAISE EXCEPTION 'simulated negotiation write failure'; END;
      $fn$ LANGUAGE plpgsql`);
    await db.none(`
      CREATE TRIGGER tbl_nrq_boom_trg BEFORE INSERT OR UPDATE ON tbl_negotiation_round_quotes
      FOR EACH ROW EXECUTE FUNCTION tbl_nrq_boom()`);

    try {
      const res = await putQuote(
        VENDOR_A,
        quoteId,
        updateBody(rfq_id, rfq_no, [productPayload({ unit_price: 450 })])
      );
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(JSON.stringify(res.body)).toMatch(/negotiation/i);
    } finally {
      await db.none(`DROP TRIGGER IF EXISTS tbl_nrq_boom_trg ON tbl_negotiation_round_quotes`);
      await db.none(`DROP FUNCTION IF EXISTS tbl_nrq_boom()`);
    }
  });
});
