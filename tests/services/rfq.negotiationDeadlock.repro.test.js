// Regression suite for the vendor negotiation deadlock reported on RFQ 560.
//
// THE BUG. A vendor whose quote predates the delivery period becoming
// mandatory could not answer a negotiation round at all. Two walls, and the
// second one is on the server, so it was never fixable in the form:
//
//   1. The wizard blocked submit ("Base price and delivery period must be
//      greater than zero") on a field it had itself disabled, because the
//      round did not open delivery_period.
//   2. Even posting directly, the server refused: the wizard re-serialises
//      the stored '' through `parseInt(x) || 0` into the number 0, the diff
//      compared "0" against "" as text, saw a change to a field the round
//      never opened, and 400'd the whole submission.
//
// The vendor could not escape either way — leaving it blank failed wall 1,
// filling it in failed wall 2 — which is what made it a deadlock rather than
// a validation message.
//
// PRODUCTION STATE THIS ENCODES (measured, not invented):
//   * tbl_quote_items.delivery_period is `text NOT NULL`, so a pre-wizard
//     quote stores '' and never NULL. 5,264 such items exist across 622
//     quotes / 362 RFQs; 471 of those quotes sit on still-live RFQs.
//   * tbl_quote_items.tax_mode is nullable and 330 items hold NULL. That one
//     resolved to `gst`, which is in ALWAYS_FROZEN_FIELDS and can never be
//     opened by any round — those lines were permanently un-revisable.
//   * RFQ 560's round 906 opened base_price + payment_terms only.
//
// THE RULE BEING LOCKED IN: filling a field that was never set is always
// allowed; changing a field the vendor actually stated still requires the
// buyer to have opened it. The last two tests are the ones that keep this
// from becoming a hole in the allowlist.

import { describe, it, expect, afterAll, beforeEach, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { makeRFQ } from "../factories/rfq.js";
import pricingEngine from "../../app/services/pricingEngine.js";

const VENDOR_A = IDS.users.vendor_alpha;

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
  await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
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

const ts = (msFromNow) =>
  new Date(Date.now() + msFromNow).toISOString().replace("T", " ").slice(0, 19);

async function makeOpenRfq() {
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
  await db.none(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', 1, 0)`,
    [rfq_id]
  );
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, 1, $2, 0)`,
    [rfq_id, VENDOR_A]
  );
  return { rfq_id, rfq_no };
}

/**
 * Seed a quote the way the PRE-wizard UI wrote them: delivery_period '' and,
 * optionally, tax_mode NULL. `seedQuote` in rfq.quoteUpdate.security.test.js
 * always writes a real delivery period, which is exactly why that suite —
 * which otherwise covers this endpoint thoroughly — never caught this.
 */
async function seedLegacyQuote(rfq_id, rfq_no, { deliveryPeriod = "", taxMode = "percentage" } = {}) {
  const quote = await db.one(
    `INSERT INTO tbl_quotes
       (rfq_id, rfq_no, status, created_by, updated_by, is_regret, global_payment_term,
        global_comment, global_charges, pricing_method)
     VALUES ($1, $2, 1, $3, $3, 0, 'Net 30', '', '[]'::jsonb, 'TRADITIONAL')
     RETURNING id`,
    [rfq_id, rfq_no, VENDOR_A]
  );
  const engine = pricingEngine.calculateLineTotal({
    unit_price: 500, quantity: "10", tax: 18, tax_mode: "percentage", other_charges: [],
  });
  await db.none(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, tax, total_price,
        comment, delivery_period, quantity, variant, tax_mode, other_charges, pricing_method)
     VALUES ($1,$2,$3,1,500,18,$4,'',$5,'10',0,$6,'[]'::jsonb,'TRADITIONAL')`,
    [rfq_id, rfq_no, quote.id, engine.total, deliveryPeriod, taxMode]
  );
  return quote.id;
}

/** Active round opening `fields` — mirrors RFQ 560 round 906 (base_price only). */
async function makeActiveRound(rfq_id, rfqProductId, fields) {
  await db.none(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, round_number, end_date, status, created_by, source_type, source_id,
        rfq_product_id, vendor_ids, vendor_approvals)
     VALUES ($1, 1, NOW() + interval '2 days', 'ACTIVE', $2, 'RFQ', $1, $3, $4::int[], $5::jsonb)`,
    [
      rfq_id, IDS.users.a1_proc_buyer, rfqProductId, [VENDOR_A],
      JSON.stringify([
        { vendor_id: VENDOR_A, negotiation_fields: fields.map((f) => ({ name: f, target: 1 })) },
      ]),
    ]
  );
}

async function rfqProductId(rfq_id) {
  const r = await db.one(
    `SELECT id FROM tbl_rfq_products WHERE rfq_id = $1 AND product_variant_id = 1 AND variant = 0`,
    [rfq_id]
  );
  return r.id;
}

/** The line exactly as SendQuoteWizard.js:1528-1568 assembles it. */
function wizardLine(overrides = {}) {
  return {
    product_id: 1,
    variant: 0,
    unit_price: 450,            // the revision the buyer asked for
    tax: 18,
    tax_mode: "percentage",
    total_price: 5310,
    comment: "",
    // `parseInt("") || 0` — SendQuoteWizard.js:1543. A stored '' comes back as 0.
    delivery_period: 0,
    quantity: "10",
    other_charges: [],
    document_files: [],
    ...overrides,
  };
}

function updateBody(rfq_id, rfq_no, products) {
  return {
    rfq_id, rfq_no, products,
    globalPaymentTerms: "Net 30",
    globalComment: "",
    global_payment_term_list: { createdTerms: [], updatedTerms: [], deletedTerms: [] },
    global_charges: [],
  };
}

async function putQuote(quoteId, body) {
  const client = await httpClient(VENDOR_A);
  return client.put(`/api/v1/rfq/quote/update/${quoteId}`).send(body);
}

const storedLine = (quoteId) =>
  db.one(`SELECT unit_price, delivery_period, tax_mode FROM tbl_quote_items WHERE quote_id = $1`, [quoteId]);

describe("vendor negotiation deadlock (RFQ 560)", () => {
  it("accepts a price revision when the stored delivery period was never set", async () => {
    const { rfq_id, rfq_no } = await makeOpenRfq();
    const quoteId = await seedLegacyQuote(rfq_id, rfq_no);          // delivery_period = ''
    await makeActiveRound(rfq_id, await rfqProductId(rfq_id), ["base_price"]);

    const res = await putQuote(quoteId, updateBody(rfq_id, rfq_no, [wizardLine()]));

    expect(res.status).toBe(200);
    const after = await storedLine(quoteId);
    expect(Number(after.unit_price)).toBe(450);
  });

  it("lets the vendor FILL a delivery period that was never stated", async () => {
    const { rfq_id, rfq_no } = await makeOpenRfq();
    const quoteId = await seedLegacyQuote(rfq_id, rfq_no);
    await makeActiveRound(rfq_id, await rfqProductId(rfq_id), ["base_price"]);

    const res = await putQuote(
      quoteId, updateBody(rfq_id, rfq_no, [wizardLine({ delivery_period: 7 })])
    );

    expect(res.status).toBe(200);
    const after = await storedLine(quoteId);
    expect(Number(after.unit_price)).toBe(450);
    expect(String(after.delivery_period)).toBe("7");
  });

  it("does not manufacture a `gst` violation from a NULL stored tax_mode", async () => {
    const { rfq_id, rfq_no } = await makeOpenRfq();
    // 330 production items are in this state. `gst` is in ALWAYS_FROZEN_FIELDS,
    // so before the fix these lines could never be revised by anyone, ever.
    const quoteId = await seedLegacyQuote(rfq_id, rfq_no, { deliveryPeriod: "7", taxMode: null });
    await makeActiveRound(rfq_id, await rfqProductId(rfq_id), ["base_price"]);

    const res = await putQuote(
      quoteId, updateBody(rfq_id, rfq_no, [wizardLine({ delivery_period: 7 })])
    );

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/gst/);
  });

  it("CONTROL: an ordinary quote with a delivery period was never affected", async () => {
    const { rfq_id, rfq_no } = await makeOpenRfq();
    const quoteId = await seedLegacyQuote(rfq_id, rfq_no, { deliveryPeriod: "7" });
    await makeActiveRound(rfq_id, await rfqProductId(rfq_id), ["base_price"]);

    const res = await putQuote(
      quoteId, updateBody(rfq_id, rfq_no, [wizardLine({ delivery_period: 7 })])
    );

    expect(res.status).toBe(200);
    expect(Number((await storedLine(quoteId)).unit_price)).toBe(450);
  });

  // ---- the allowlist must NOT have become a hole -------------------------

  it("still refuses to CHANGE a delivery period the vendor actually stated", async () => {
    const { rfq_id, rfq_no } = await makeOpenRfq();
    const quoteId = await seedLegacyQuote(rfq_id, rfq_no, { deliveryPeriod: "7" });
    await makeActiveRound(rfq_id, await rfqProductId(rfq_id), ["base_price"]);

    const res = await putQuote(
      quoteId, updateBody(rfq_id, rfq_no, [wizardLine({ delivery_period: 21 })])
    );

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/delivery_period/);
    const after = await storedLine(quoteId);
    expect(String(after.delivery_period)).toBe("7");
    expect(Number(after.unit_price)).toBe(500);   // nothing else slipped through either
  });

  it("still refuses to CLEAR a delivery period the vendor actually stated", async () => {
    const { rfq_id, rfq_no } = await makeOpenRfq();
    const quoteId = await seedLegacyQuote(rfq_id, rfq_no, { deliveryPeriod: "7" });
    await makeActiveRound(rfq_id, await rfqProductId(rfq_id), ["base_price"]);

    // delivery_period 0 is how the wizard spells "blank" — against a stored
    // "7" that is the vendor withdrawing a commitment, not filling a gap.
    const res = await putQuote(quoteId, updateBody(rfq_id, rfq_no, [wizardLine()]));

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/delivery_period/);
  });

  it("still refuses a real GST change (gst can never be opened by a round)", async () => {
    const { rfq_id, rfq_no } = await makeOpenRfq();
    const quoteId = await seedLegacyQuote(rfq_id, rfq_no, { deliveryPeriod: "7" });
    await makeActiveRound(rfq_id, await rfqProductId(rfq_id), ["base_price"]);

    const res = await putQuote(
      quoteId, updateBody(rfq_id, rfq_no, [wizardLine({ delivery_period: 7, tax: 12 })])
    );

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/gst/);
    expect(Number((await storedLine(quoteId)).unit_price)).toBe(500);
  });

  it("still refuses a price change when the round opened only freight", async () => {
    const { rfq_id, rfq_no } = await makeOpenRfq();
    const quoteId = await seedLegacyQuote(rfq_id, rfq_no);   // empty delivery period
    await makeActiveRound(rfq_id, await rfqProductId(rfq_id), ["freight"]);

    // The delivery-period gap must not become a general bypass of the allowlist.
    const res = await putQuote(quoteId, updateBody(rfq_id, rfq_no, [wizardLine()]));

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/base_price/);
    expect(Number((await storedLine(quoteId)).unit_price)).toBe(500);
  });
});
