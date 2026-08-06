// Negotiation metrics attached to the quote-comparison view, for the summary
// Excel export.
//
// The point of these tests is that the exported number AGREES with what the
// user already sees. "How much did negotiation save" has several competing
// definitions in this codebase; the export must reuse the one the negotiation
// dashboard uses, or a downloaded summary will contradict the screen. The
// reconciliation test below is the one that matters.
//
// The other thing worth pinning: absence must read as absence. In production,
// 26 of 125 negotiated RFQs have no price history to form a baseline from, and
// "₹0 saved" is indistinguishable from "not measurable" once it is in a
// spreadsheet cell.

import { describe, it, expect, beforeAll, afterEach } from "@jest/globals";
import { db } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import negotiationModel from "../../app/models/negotiationModel.js";
import { buildNegotiationMetrics } from "../../app/services/quoteComparisonMetrics.js";
import { makeRfqVisibleToDashboard, cleanupRfqs } from "../helpers/dashboardSeed.js";

const BUYER = IDS.users.a1_proc_buyer;
const VA = IDS.users.vendor_alpha;

const inserted = { rfqIds: [], roundIds: [] };

async function seedRfq(title) {
  const r = await makeRfqVisibleToDashboard(db, {
    createdBy: BUYER, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
    department: IDS.departments.proc, process: IDS.processes.A_P1,
    is_published: 1, status: 1, title,
  });
  inserted.rfqIds.push(Number(r.rfq_id));
  return { id: Number(r.rfq_id), no: Number(r.rfq_no) };
}

async function addProduct(rfq, variantId) {
  const row = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, product_variant_id, variant, comment, spec_file, qap_file)
     VALUES ($1, $2, 0, '', '0', '0') RETURNING id`,
    [rfq.id, variantId]
  );
  return Number(row.id);
}

// `current` is the live (already negotiated) line total; `historyTotal` is the
// original offer, which is the baseline the ladder reaches back to.
async function addQuoteWithHistory(rfq, variantId, { current, historyTotal }) {
  const q = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, status, created_by, updated_by, "timestamp", is_regret)
     VALUES ($1, $2, 1, $3, $3, now(), 0) RETURNING id`,
    [rfq.id, rfq.no, VA]
  );
  const qi = await db.one(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, variant, product_name,
        unit_price, package_price, tax, freight_price, total_price, quantity,
        tax_mode, comment, delivery_period)
     VALUES ($1, $2, $3, $4, 0, 'Metrics line', $5, 0, 0, 0, $5, '1', 'percentage', '', '7')
     RETURNING id`,
    [rfq.id, rfq.no, q.id, variantId, current]
  );
  if (historyTotal != null) {
    await db.none(
      `INSERT INTO tbl_quote_item_history
         (quote_item_id, rfq_id, product_variant_id, variant, unit_price, package_price,
          tax, freight_price, total_price, quantity, tax_mode, timestamp)
       VALUES ($1, $2, $3, 0, $4, 0, 0, 0, $4, '1', 'percentage', now() - interval '2 hours')`,
      [qi.id, rfq.id, variantId, historyTotal]
    );
  }
  return Number(qi.id);
}

async function addRound(rfq, { number, agoDays, status = "ENDED", productId = null }) {
  const row = await db.one(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, source_type, source_id, round_number, status, end_date, vendor_ids,
        created_by, created_at, rfq_product_id)
     VALUES ($1, 'RFQ', $1, $2, $3, now() - ($4 || ' days')::interval, $5::int[], $6,
             now() - ($4 || ' days')::interval, $7)
     RETURNING id`,
    [rfq.id, number, status, String(agoDays), [VA], BUYER, productId]
  );
  inserted.roundIds.push(Number(row.id));
  return Number(row.id);
}

async function addRoundQuote(roundId, rfqProductId, price) {
  await db.none(
    `INSERT INTO tbl_negotiation_round_quotes
       (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, submitted_at, created_at)
     VALUES ($1, $2, $3, $4, now(), now())`,
    [roundId, VA, rfqProductId, price]
  );
}

let client;
beforeAll(async () => {
  client = await httpClient(BUYER);
});

afterEach(async () => {
  if (inserted.roundIds.length) {
    await db.none(
      `DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`,
      [inserted.roundIds]
    );
    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [inserted.roundIds]);
    inserted.roundIds = [];
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_quote_item_history WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(
      `DELETE FROM tbl_quote_items WHERE quote_id IN (SELECT id FROM tbl_quotes WHERE rfq_id = ANY($1::int[]))`,
      [inserted.rfqIds]
    );
    await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await cleanupRfqs(db, inserted.rfqIds);
    inserted.rfqIds = [];
  }
});

describe("quote comparison — negotiation metrics", () => {
  it("reports absence, not zero, when the RFQ was never negotiated", async () => {
    const rfq = await seedRfq("Metrics: no negotiation");
    const pid = await addProduct(rfq, 13125);
    await addQuoteWithHistory(rfq, 13125, { current: 1000, historyTotal: null });

    const m = await buildNegotiationMetrics(rfq.id);

    expect(m.available).toBe(false);
    expect(m.rounds_created).toBe(0);
    expect(m.rounds_ran).toBe(0);
    // Null, never 0 — in a spreadsheet those two look identical and mean
    // completely different things.
    expect(m.gain_value).toBeNull();
    expect(m.gain_pct).toBeNull();
    expect(pid).toBeGreaterThan(0);
  });

  it("measures the gain against the original offer and counts the rounds", async () => {
    const rfq = await seedRfq("Metrics: one round");
    const pid = await addProduct(rfq, 13125);
    // Vendor originally offered 1000, settled at 800.
    await addQuoteWithHistory(rfq, 13125, { current: 800, historyTotal: 1000 });
    const r1 = await addRound(rfq, { number: 1, agoDays: 2, productId: pid });
    await addRoundQuote(r1, pid, 800);

    const m = await buildNegotiationMetrics(rfq.id);

    expect(m.available).toBe(true);
    expect(m.rounds_created).toBe(1);
    expect(m.rounds_ran).toBe(1);
    expect(m.rounds_cancelled).toBe(0);
    expect(m.products_negotiated).toBe(1);
    expect(m.baseline_total).toBe(1000);
    expect(m.achieved_total).toBe(800);
    expect(m.gain_value).toBe(200);
    expect(m.gain_pct).toBe(20);
    // Provenance travels with the number so it can be defended.
    expect(m.baseline_sources).toBeTruthy();
  });

  it("keeps a price INCREASE negative rather than clamping it to zero", async () => {
    const rfq = await seedRfq("Metrics: price rose");
    const pid = await addProduct(rfq, 13125);
    await addQuoteWithHistory(rfq, 13125, { current: 1200, historyTotal: 1000 });
    const r1 = await addRound(rfq, { number: 1, agoDays: 2, productId: pid });
    await addRoundQuote(r1, pid, 1200);

    const m = await buildNegotiationMetrics(rfq.id);

    // Production has RFQs that ended above their baseline. A floor of zero
    // would hide them, and hiding them is how a report loses credibility.
    expect(m.gain_value).toBe(-200);
    expect(m.gain_pct).toBe(-20);
  });

  it("counts a cancelled round as created but not as run", async () => {
    const rfq = await seedRfq("Metrics: cancelled round");
    const pid = await addProduct(rfq, 13125);
    await addQuoteWithHistory(rfq, 13125, { current: 900, historyTotal: 1000 });
    const live = await addRound(rfq, { number: 1, agoDays: 3, productId: pid });
    await addRoundQuote(live, pid, 900);
    await addRound(rfq, { number: 2, agoDays: 1, status: "CANCELLED", productId: pid });

    const m = await buildNegotiationMetrics(rfq.id);

    expect(m.rounds_created).toBe(2);
    expect(m.rounds_ran).toBe(1);
    expect(m.rounds_cancelled).toBe(1);
  });

  // THE test. If this drifts, the downloaded summary starts contradicting the
  // negotiation dashboard, and users lose trust in both.
  it("reconciles exactly with the ladder the negotiation dashboard uses", async () => {
    const rfq = await seedRfq("Metrics: reconcile");
    const pid = await addProduct(rfq, 13125);
    await addQuoteWithHistory(rfq, 13125, { current: 742.5, historyTotal: 1100 });
    const r1 = await addRound(rfq, { number: 1, agoDays: 2, productId: pid });
    await addRoundQuote(r1, pid, 742.5);

    const [ladder] = await negotiationModel.getNegotiationParentSavings([rfq.id]);
    const m = await buildNegotiationMetrics(rfq.id);

    expect(m.baseline_total).toBe(Math.round(Number(ladder.baseline_total) * 100) / 100);
    expect(m.achieved_total).toBe(Math.round(Number(ladder.achieved_total) * 100) / 100);
    expect(m.gain_value).toBe(
      Math.round((Number(ladder.baseline_total) - Number(ladder.achieved_total)) * 100) / 100
    );
    expect(m.pairs_counted).toBe(Number(ladder.pairs_counted));
  });

  it("rides along on the quote-comparison view the page already fetches", async () => {
    const rfq = await seedRfq("Metrics: on the view");
    const pid = await addProduct(rfq, 13125);
    await addQuoteWithHistory(rfq, 13125, { current: 800, historyTotal: 1000 });
    const r1 = await addRound(rfq, { number: 1, agoDays: 2, productId: pid });
    await addRoundQuote(r1, pid, 800);

    const res = await client.get(`/api/v1/rfq/quote-comparison-view/${rfq.id}`);
    expect(res.status).toBe(200);

    // No extra round-trip for the export: the metrics arrive with the view.
    expect(res.body.negotiation_metrics).toBeTruthy();
    expect(res.body.negotiation_metrics.gain_value).toBe(200);
    expect(res.body.negotiation_metrics.rounds_ran).toBe(1);
  });

  it("does not serve the metrics to a caller outside the tenant", async () => {
    const rfq = await seedRfq("Metrics: tenant boundary");
    await addProduct(rfq, 13125);
    await addQuoteWithHistory(rfq, 13125, { current: 800, historyTotal: 1000 });

    // The ladder applies no scope of its own — it is safe only because the
    // handler gates the id first. Prove the gate still bites.
    const outsider = await httpClient(IDS.users.companyB_admin);
    const res = await outsider.get(`/api/v1/rfq/quote-comparison-view/${rfq.id}`);

    expect(res.status).not.toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/negotiation_metrics/);
  });
});
