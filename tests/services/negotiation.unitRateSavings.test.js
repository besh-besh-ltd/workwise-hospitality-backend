// Negotiation savings — telling a UNIT-rate round price from a LINE total.
// ---------------------------------------------------------------------------
// Round quotes are meant to be line totals, but 26 of 728 prod prices were
// typed at unit rate (RFQ 808: qty 600, ₹385 → ₹362) and understated savings
// by the quantity, so getNegotiationParentSavings scales a price by the line
// quantity when it sits nearer the unit price than the line total.
//
// At small quantities that rule alone is ambiguous: at qty 2 a line-total
// offer 30% below the line (₹1,400 on a ₹2,000 line, unit ₹1,000) is nearer
// the unit price and would be DOUBLED into a ₹800 "loss". A unit rate is never
// far above the unit price, so a price is scaled only when it is also at most
// 1.2 × the line's unit price.
//
// Pattern B (commit + cleanup).

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

const { default: negotiationModel } = await import("../../app/models/negotiationModel.js");

const VA = IDS.users.vendor_alpha;
const PAST = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const rfqIds = [];
const roundIds = [];
const seeded = {};

/** One RFQ, one line, one vendor quote (unit × qty), one ENDED round price. */
async function seed(title, { variantId, unit, qty, roundPrice }) {
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: IDS.users.superAdmin,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
    title: `UNITRATE-${title}`,
  });
  rfqIds.push(Number(rfq_id));
  const rp = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, product_variant_id, variant, comment, spec_file, qap_file)
     VALUES ($1, $2, 0, 'line', '0', '0') RETURNING id`,
    [rfq_id, variantId]
  );
  const q = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, status, created_by, updated_by, "timestamp", is_regret)
     VALUES ($1, $2, 1, $3, $3, now(), 0) RETURNING id`,
    [rfq_id, rfq_no, VA]
  );
  await db.none(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, variant, product_name,
        unit_price, package_price, tax, freight_price, total_price, quantity,
        tax_mode, comment, delivery_period)
     VALUES ($1, $2, $3, $4, 0, 'line product', $5, 0, 0, 0, $6, $7, 'percentage', '', '7')`,
    [rfq_id, rfq_no, q.id, variantId, unit, unit * qty, String(qty)]
  );
  const round = await db.one(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, source_type, source_id, round_number, status, end_date, vendor_ids, created_by, created_at)
     VALUES ($1, 'RFQ', $1, 1, 'ENDED', $2, $3::int[], $4, $2)
     RETURNING id`,
    [rfq_id, PAST(3), [VA], IDS.users.superAdmin]
  );
  roundIds.push(Number(round.id));
  await db.none(
    `INSERT INTO tbl_negotiation_round_quotes
       (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, submitted_at, created_at)
     VALUES ($1, $2, $3, $4, now(), now())`,
    [round.id, VA, rp.id, roundPrice]
  );
  return Number(rfq_id);
}

beforeAll(async () => {
  // qty 2, unit 1,000 (line 2,000); the vendor's round offer is a LINE total
  // of 1,400 — a 30% cut. Nearer the unit price, but 1.4 × unit: not a rate.
  seeded.lineOffer = await seed("qty2-line-offer", { variantId: 1, unit: 1000, qty: 2, roundPrice: 1400 });
  // Prod RFQ 808's shape: qty 600, unit 385 (line 2,31,000), round price 362
  // is a unit rate — it must still be scaled to a 2,17,200 line.
  seeded.unitOffer = await seed("qty600-unit-offer", { variantId: 2, unit: 385, qty: 600, roundPrice: 362 });
});

afterAll(async () => {
  await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`, [roundIds]);
  await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [roundIds]);
  await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [rfqIds]);
  await closeDb();
});

const savingsFor = async (rfqId) => {
  const rows = await negotiationModel.getNegotiationParentSavings([rfqId]);
  const row = rows.find((r) => Number(r.rfq_id) === rfqId);
  expect(row).toBeDefined();
  return { baseline: Number(row.baseline_total), achieved: Number(row.achieved_total) };
};

describe("unit-rate normalisation in negotiation savings", () => {
  it("does not double a qty-2 line-total offer 30% below the line", async () => {
    const { baseline, achieved } = await savingsFor(seeded.lineOffer);
    expect(baseline).toBe(2000);
    expect(achieved).toBe(1400);
  });

  it("still scales a genuine unit-rate price by the line quantity", async () => {
    const { baseline, achieved } = await savingsFor(seeded.unitOffer);
    expect(baseline).toBe(231000);
    expect(achieved).toBe(362 * 600);
  });
});
