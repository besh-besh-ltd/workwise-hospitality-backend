// Quote Comparison — negotiation state on products and cells.
// ---------------------------------------------------------------------------
// The screen used to carry a separate "Negotiation status" panel fed by a
// DIFFERENT endpoint (GET /rfq/:id/lifecycle) than the table below it, so a
// buyer had to read two disconnected surfaces to answer "what is happening with
// this product". This contract moves negotiation into the comparison payload.
//
// Two things make that harder than it sounds, and both are guarded here:
//
//   1. A round's coverage lives in TWO carriers. Single-product rounds use the
//      legacy `rfq_product_id` column + `vendor_approvals[].negotiation_fields`;
//      multi-product and RFQ-level rounds use the `products` JSONB with
//      rfq_product_id NULL. The old fetchActiveRounds filtered
//      `WHERE rfq_product_id = ANY(...)`, so EVERY multi-product and RFQ-level
//      round rendered as "no round at all".
//
//   2. `target_price` is dead legacy (71 of 887 production rounds, all created
//      before 2026-05-01). The live shape is per-vendor, per-field targets over
//      an OPEN-ENDED field-name set — 16 names in production, drawn from tenant
//      charge names. 74 rounds have no numeric ask whatsoever, and 83 field
//      entries carry only a free-text `demand` with an empty target.
//
// Pattern B (commit + cleanup).
//   TEST_RUN_ID=<unique> npm test -- --testPathPatterns "quoteComparisonView.negotiation"

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

let VARIANT_A = 1;
let VARIANT_B = 2;

beforeAll(async () => {
  const vs = await db.any(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 2`);
  if (vs[0]) VARIANT_A = vs[0].id;
  if (vs[1]) VARIANT_B = vs[1].id;
});

const inserted = { rfqIds: [], rfqProductIds: [], quoteIds: [], roundIds: [] };

beforeEach(() => {
  for (const k of Object.keys(inserted)) inserted[k] = [];
});

afterEach(async () => {
  if (inserted.roundIds.length) {
    await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`, [inserted.roundIds]);
    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [inserted.roundIds]);
  }
  if (inserted.quoteIds.length) {
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

// ---- helpers ---------------------------------------------------------------

const tsString = (offsetMs) =>
  new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);

const HOSP_HEADER = "x-hospitality-company";
const VIEW = (id) => `/api/v1/rfq/quote-comparison-view/${id}`;

async function scopedClient(userId, hospitality = IDS.hospitality.A) {
  const c = await httpClient(userId);
  return { get: (url) => c.get(url).set(HOSP_HEADER, String(hospitality)) };
}

async function makeViewableRfq() {
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    tender_publish_date: tsString(-2 * 86400_000),
    vendor_clarification_date: tsString(-86400_000),
    bid_end_date: tsString(-3600_000), // past => quotes unlocked
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
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

async function plantQuote(rfq_id, rfq_no, vendorId, { productVariantId = VARIANT_A, variant = 0, unitPrice = 500, quantity = 10, tax = 18 } = {}) {
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
      String(quantity), JSON.stringify([]), productVariantId, variant,
    ]
  );
  return q.id;
}

// A legacy single-product round: coverage in rfq_product_id, targets in
// vendor_approvals[].negotiation_fields. 886 of 887 production rounds.
async function makeLegacyRound(rfq_id, rfq_product_id, { status = "ACTIVE", endOffsetMs = 86400_000, vendorFields = [] } = {}) {
  const r = await db.one(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, round_number, end_date, status, rfq_product_id, vendor_ids, vendor_approvals, source_type, source_id, created_by, created_at)
     VALUES ($1, 1, $2, $3, $4, $5::int[], $6::jsonb, 'RFQ', $1, $7, now())
     RETURNING id`,
    [
      rfq_id,
      tsString(endOffsetMs),
      status,
      rfq_product_id,
      vendorFields.map((v) => v.vendor_id),
      JSON.stringify(vendorFields.map((v) => ({
        vendor_id: v.vendor_id, status: "PENDING", remarks: null, acted_by: null, acted_at: null,
        negotiation_fields: v.fields,
      }))),
      IDS.users.a1_proc_buyer,
    ]
  );
  inserted.roundIds.push(r.id);
  return r.id;
}

// A multi-product round with an RFQ-level entry — the shape the current wizard
// produces and the one the old code could not see at all.
async function makeMultiRound(rfq_id, productEntries, rfqLevelTargets, vendorIds) {
  const products = [
    ...productEntries,
    { is_rfq_level: true, vendor_targets: rfqLevelTargets },
  ];
  const r = await db.one(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, round_number, end_date, status, rfq_product_id, vendor_ids, vendor_approvals, products, source_type, source_id, created_by, created_at)
     VALUES ($1, 1, $2, 'ACTIVE', NULL, $3::int[], $4::jsonb, $5::jsonb, 'RFQ', $1, $6, now())
     RETURNING id`,
    [
      rfq_id,
      tsString(86400_000),
      vendorIds,
      JSON.stringify(vendorIds.map((v) => ({ vendor_id: v, status: "PENDING", remarks: null, acted_by: null, acted_at: null }))),
      JSON.stringify(products),
      IDS.users.a1_proc_buyer,
    ]
  );
  inserted.roundIds.push(r.id);
  return r.id;
}

async function respond(roundId, vendorId, rfqProductId, quotedPrice) {
  await db.none(
    `INSERT INTO tbl_negotiation_round_quotes
       (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, submitted_at, created_at)
     VALUES ($1, $2, $3, $4, now(), now())`,
    [roundId, vendorId, rfqProductId, quotedPrice]
  );
}

const productOf = (body, rfqProductId) =>
  (body.products || []).find((p) => Number(p.id) === Number(rfqProductId));

const VENDOR_A = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;

// ===========================================================================

describe("quote-comparison-view — negotiation on a single-product round", () => {
  it("reports state, round position and reply counts on the product", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, VENDOR_A);
    await plantQuote(rfq_id, rfq_no, VENDOR_B);
    await makeLegacyRound(rfq_id, rfq_product_id, {
      vendorFields: [
        { vendor_id: VENDOR_A, fields: [{ name: "base_price", target: "450" }] },
        { vendor_id: VENDOR_B, fields: [{ name: "base_price", target: "450" }] },
      ],
    });

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const p = productOf((await client.get(VIEW(rfq_id))).body, rfq_product_id);

    expect(p.negotiation).toBeTruthy();
    expect(p.negotiation.state).toBe("open_with_vendors");
    expect(p.negotiation.round_position).toBe(1);
    expect(p.negotiation.invited_count).toBe(2);
    expect(p.negotiation.responded_count).toBe(0);
    expect(p.negotiation.asks.map((a) => a.field)).toContain("base_price");
  });

  it("flags responded only for the vendor with a round-quote row", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, VENDOR_A);
    await plantQuote(rfq_id, rfq_no, VENDOR_B);
    const roundId = await makeLegacyRound(rfq_id, rfq_product_id, {
      vendorFields: [
        { vendor_id: VENDOR_A, fields: [{ name: "base_price", target: "450" }] },
        { vendor_id: VENDOR_B, fields: [{ name: "base_price", target: "450" }] },
      ],
    });
    await respond(roundId, VENDOR_A, rfq_product_id, 4200);

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const p = productOf((await client.get(VIEW(rfq_id))).body, rfq_product_id);

    expect(p.negotiation.responded_count).toBe(1);
    expect(p.quotes[String(VENDOR_A)].negotiation.responded).toBe(true);
    expect(p.quotes[String(VENDOR_A)].negotiation.quoted_price).toBe(4200);
    // quoted_price is a LINE TOTAL for RFQ rounds while base_price targets are
    // per UNIT — the client must never divide one by the other.
    expect(p.quotes[String(VENDOR_A)].negotiation.amount_basis).toBe("line_total");
    expect(p.quotes[String(VENDOR_B)].negotiation.responded).toBe(false);
    expect(p.quotes[String(VENDOR_B)].negotiation.quoted_price).toBeNull();
  });

  it("returns each vendor its OWN targets when they differ", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, VENDOR_A);
    await plantQuote(rfq_id, rfq_no, VENDOR_B);
    await makeLegacyRound(rfq_id, rfq_product_id, {
      vendorFields: [
        { vendor_id: VENDOR_A, fields: [{ name: "base_price", target: "450" }] },
        { vendor_id: VENDOR_B, fields: [{ name: "base_price", target: "400" }] },
      ],
    });

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const p = productOf((await client.get(VIEW(rfq_id))).body, rfq_product_id);

    const a = p.quotes[String(VENDOR_A)].negotiation.asks.find((x) => x.field === "base_price");
    const b = p.quotes[String(VENDOR_B)].negotiation.asks.find((x) => x.field === "base_price");
    expect(a.target).toBe("450");
    expect(b.target).toBe("400");
  });

  it("returns negotiation null on a product with no round", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, VENDOR_A);

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const p = productOf((await client.get(VIEW(rfq_id))).body, rfq_product_id);

    expect(p.negotiation).toBeNull();
  });
});

describe("quote-comparison-view — multi-product and RFQ-level rounds", () => {
  it("resolves a MULTI-PRODUCT round onto every product it covers", async () => {
    // Regression guard: the old fetchActiveRounds filtered
    // `rfq_product_id = ANY(...)`, so this round yielded "no round" everywhere.
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const p1 = await addProduct(rfq_id, VARIANT_A, 0);
    const p2 = await addProduct(rfq_id, VARIANT_B, 0);
    await plantQuote(rfq_id, rfq_no, VENDOR_A, { productVariantId: VARIANT_A });
    await plantQuote(rfq_id, rfq_no, VENDOR_A, { productVariantId: VARIANT_B });

    const roundId = await makeMultiRound(
      rfq_id,
      [
        { rfq_product_id: p1.rfq_product_id, vendor_targets: [{ vendor_id: VENDOR_A, fields: [{ name: "base_price", target: "450" }] }] },
        { rfq_product_id: p2.rfq_product_id, vendor_targets: [{ vendor_id: VENDOR_A, fields: [{ name: "base_price", target: "300" }] }] },
      ],
      [{ vendor_id: VENDOR_A, fields: [{ name: "payment_terms", target: "100% Credit 21 days" }] }],
      [VENDOR_A]
    );

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const body = (await client.get(VIEW(rfq_id))).body;

    for (const pid of [p1.rfq_product_id, p2.rfq_product_id]) {
      const p = productOf(body, pid);
      expect(p.negotiation).toBeTruthy();
      expect(p.negotiation.round_id).toBe(roundId);
    }
  });

  it("surfaces the RFQ-level ask on every product row", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const p1 = await addProduct(rfq_id, VARIANT_A, 0);
    const p2 = await addProduct(rfq_id, VARIANT_B, 0);
    await plantQuote(rfq_id, rfq_no, VENDOR_A, { productVariantId: VARIANT_A });
    await plantQuote(rfq_id, rfq_no, VENDOR_A, { productVariantId: VARIANT_B });

    await makeMultiRound(
      rfq_id,
      [
        { rfq_product_id: p1.rfq_product_id, vendor_targets: [{ vendor_id: VENDOR_A, fields: [{ name: "base_price", target: "450" }] }] },
        { rfq_product_id: p2.rfq_product_id, vendor_targets: [{ vendor_id: VENDOR_A, fields: [{ name: "base_price", target: "300" }] }] },
      ],
      [{ vendor_id: VENDOR_A, fields: [{ name: "payment_terms", target: "100% Credit 21 days" }] }],
      [VENDOR_A]
    );

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const body = (await client.get(VIEW(rfq_id))).body;

    for (const pid of [p1.rfq_product_id, p2.rfq_product_id]) {
      const asks = productOf(body, pid).negotiation.rfq_level_asks;
      expect(asks.map((a) => a.field)).toContain("payment_terms");
      expect(asks.find((a) => a.field === "payment_terms").is_text).toBe(true);
    }
  });
});

describe("quote-comparison-view — invited count is per product", () => {
  it("counts only the vendors actually asked on THIS product", async () => {
    // Production round 896 asks two vendors overall but only one on two of its
    // products. A round-wide denominator renders "0 of 2 replied" where the
    // true denominator is 1 — and this is the shape every new round uses.
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const both = await addProduct(rfq_id, VARIANT_A, 0);
    const onlyA = await addProduct(rfq_id, VARIANT_B, 0);
    await plantQuote(rfq_id, rfq_no, VENDOR_A, { productVariantId: VARIANT_A });
    await plantQuote(rfq_id, rfq_no, VENDOR_B, { productVariantId: VARIANT_A });
    await plantQuote(rfq_id, rfq_no, VENDOR_A, { productVariantId: VARIANT_B });
    await plantQuote(rfq_id, rfq_no, VENDOR_B, { productVariantId: VARIANT_B });

    await makeMultiRound(
      rfq_id,
      [
        { rfq_product_id: both.rfq_product_id, vendor_targets: [
          { vendor_id: VENDOR_A, fields: [{ name: "base_price", target: "450" }] },
          { vendor_id: VENDOR_B, fields: [{ name: "base_price", target: "450" }] },
        ] },
        { rfq_product_id: onlyA.rfq_product_id, vendor_targets: [
          { vendor_id: VENDOR_A, fields: [{ name: "base_price", target: "300" }] },
        ] },
      ],
      [],
      [VENDOR_A, VENDOR_B]
    );

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const body = (await client.get(VIEW(rfq_id))).body;

    expect(productOf(body, both.rfq_product_id).negotiation.invited_count).toBe(2);
    expect(productOf(body, onlyA.rfq_product_id).negotiation.invited_count).toBe(1);
  });

  it("falls back to the round-wide list for a legacy round with no per-product targets", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, VENDOR_A);
    await plantQuote(rfq_id, rfq_no, VENDOR_B);
    await makeLegacyRound(rfq_id, rfq_product_id, {
      vendorFields: [
        { vendor_id: VENDOR_A, fields: [{ name: "base_price", target: "450" }] },
        { vendor_id: VENDOR_B, fields: [{ name: "base_price", target: "450" }] },
      ],
    });

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const p = productOf((await client.get(VIEW(rfq_id))).body, rfq_product_id);

    expect(p.negotiation.invited_count).toBe(2);
  });
});

describe("quote-comparison-view — a PURELY RFQ-level round", () => {
  it("surfaces the whole-RFQ ask even though the round covers no product id", async () => {
    // The wizard's "RFQ-level negotiation" radio produces a products JSONB with
    // ONLY { is_rfq_level: true } — getCoveredProductIds returns [] for it, so
    // without an explicit branch the ask renders on no row anywhere and the
    // feature silently disappears on its most natural creation path.
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const p1 = await addProduct(rfq_id, VARIANT_A, 0);
    const p2 = await addProduct(rfq_id, VARIANT_B, 0);
    await plantQuote(rfq_id, rfq_no, VENDOR_A, { productVariantId: VARIANT_A });
    await plantQuote(rfq_id, rfq_no, VENDOR_A, { productVariantId: VARIANT_B });

    const roundId = await makeMultiRound(
      rfq_id,
      [], // no product entries at all
      [{ vendor_id: VENDOR_A, fields: [{ name: "payment_terms", target: "100% Credit 21 days" }] }],
      [VENDOR_A]
    );

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const body = (await client.get(VIEW(rfq_id))).body;

    for (const pid of [p1.rfq_product_id, p2.rfq_product_id]) {
      const n = productOf(body, pid).negotiation;
      expect(n).toBeTruthy();
      expect(n.round_id).toBe(roundId);
      expect(n.rfq_level_asks.map((a) => a.field)).toContain("payment_terms");
      // The round is not about this product, so the per-product counters and
      // asks are deliberately empty rather than invented.
      expect(n.asks).toEqual([]);
      expect(n.round_position).toBeNull();
    }
  });
});

describe("quote-comparison-view — non-numeric and target-less asks", () => {
  it("marks a payment_terms ask as text with a readable label", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, VENDOR_A);
    await makeLegacyRound(rfq_id, rfq_product_id, {
      vendorFields: [{ vendor_id: VENDOR_A, fields: [{ name: "payment_terms", target: "100% Credit 21 days" }] }],
    });

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const ask = productOf((await client.get(VIEW(rfq_id))).body, rfq_product_id)
      .negotiation.asks.find((a) => a.field === "payment_terms");

    expect(ask.is_text).toBe(true);
    expect(ask.label).toBe("Payment terms");
  });

  it("keeps a documents ask that carries only a demand and an empty target", async () => {
    // 83 production field entries look exactly like this.
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, VENDOR_A);
    await makeLegacyRound(rfq_id, rfq_product_id, {
      vendorFields: [{
        vendor_id: VENDOR_A,
        fields: [{ name: "documents", target: [], demand: "Need photos and quotation" }],
      }],
    });

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const ask = productOf((await client.get(VIEW(rfq_id))).body, rfq_product_id)
      .negotiation.asks.find((a) => a.field === "documents");

    expect(ask.demand).toBe("Need photos and quotation");
    expect(ask.target).toEqual([]);
    expect(ask.is_text).toBe(true);
  });

  it("labels an unknown tenant charge slug rather than dropping it", async () => {
    // Field names are open-ended — tenant charge slugs from tbl_charge_names.
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, VENDOR_A);
    await makeLegacyRound(rfq_id, rfq_product_id, {
      vendorFields: [{
        vendor_id: VENDOR_A,
        fields: [{ name: "loading_unloading", target: "500", mode: "absolute" }],
      }],
    });

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const ask = productOf((await client.get(VIEW(rfq_id))).body, rfq_product_id)
      .negotiation.asks.find((a) => a.field === "loading_unloading");

    expect(ask.label).toBe("Loading Unloading");
    expect(ask.mode).toBe("absolute");
    expect(ask.is_text).toBe(false);
  });
});

describe("quote-comparison-view — round states", () => {
  it("an ENDED round with no responses reads as no_vendor_response", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, VENDOR_A);
    await makeLegacyRound(rfq_id, rfq_product_id, {
      status: "ENDED", endOffsetMs: -3600_000,
      vendorFields: [{ vendor_id: VENDOR_A, fields: [{ name: "base_price", target: "450" }] }],
    });

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const p = productOf((await client.get(VIEW(rfq_id))).body, rfq_product_id);

    expect(p.negotiation.state).toBe("no_vendor_response");
  });

  it("an ENDED round WITH a response reads as ready_for_decision", async () => {
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, VENDOR_A);
    const roundId = await makeLegacyRound(rfq_id, rfq_product_id, {
      status: "ENDED", endOffsetMs: -3600_000,
      vendorFields: [{ vendor_id: VENDOR_A, fields: [{ name: "base_price", target: "450" }] }],
    });
    await respond(roundId, VENDOR_A, rfq_product_id, 4200);

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const p = productOf((await client.get(VIEW(rfq_id))).body, rfq_product_id);

    expect(p.negotiation.state).toBe("ready_for_decision");
  });

  it("an ACTIVE round whose window has closed is NOT open_with_vendors", async () => {
    // The expiry cron is a one-shot per round; a missed tick leaves the row
    // ACTIVE past end_date indefinitely, so every read must re-derive.
    const { rfq_id, rfq_no } = await makeViewableRfq();
    const { rfq_product_id } = await addProduct(rfq_id, VARIANT_A);
    await plantQuote(rfq_id, rfq_no, VENDOR_A);
    await makeLegacyRound(rfq_id, rfq_product_id, {
      status: "ACTIVE", endOffsetMs: -3600_000,
      vendorFields: [{ vendor_id: VENDOR_A, fields: [{ name: "base_price", target: "450" }] }],
    });

    const client = await scopedClient(IDS.users.a1_proc_buyer);
    const p = productOf((await client.get(VIEW(rfq_id))).body, rfq_product_id);

    expect(p.negotiation.state).not.toBe("open_with_vendors");
    expect(p.negotiation.state).toBe("no_vendor_response");
  });
});
