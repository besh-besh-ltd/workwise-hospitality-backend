// dashboard.negotiationSavingsLadder.test.js — the buyer dashboard must agree
// with the negotiation module about how much a negotiation saved.
//
// GET /api/v1/dashboard-v2/negotiation-savings used to compute
//
//   round_number = 1 quoted_price  −  last round quoted_price
//
// which is wrong three times over, measured against production:
//
//   1. `JOIN tbl_negotiation_rounds nr ON ... AND nr.round_number = 1` only
//      reached 274 of 441 quote pairs. 167 pairs live on RFQs with no round
//      numbered 1 and contributed NOTHING.
//   2. 243 of the 274 it did reach (89%) compared a round against ITSELF: on a
//      single-round negotiation, round 1 IS the last round, so the delta is
//      exactly ₹0. The real baseline for a first round is the vendor's ORIGINAL
//      RFQ quote, in tbl_quote_item_history — which the widget never read.
//   3. The remainder was inflated by a clamp: suppressing genuine price RISES
//      instead of subtracting them turned a real ₹3,15,379 into ₹4,26,825.
//
// The fix repoints the widget at the SAME baseline ladder the negotiation
// module and the round-detail page already use —
// previous_price → quote_history → prior_round → current_quote, taken at the
// pair's EARLIEST round, achieved at its LATEST, CANCELLED rounds excluded,
// SIGNED and never clamped — by calling
// negotiationModel.getNegotiationParentSavings on the scoped RFQ ids.
//
// Production, all-vendor basis: ₹98,45,639 saved on a ₹8,04,14,568 baseline,
// where the old query reported ₹3,15,379 on ₹4,07,77,896.
//
// Every test measures a DELTA against a baseline reading so it survives a
// shared seed DB.

import { describe, it, expect, afterAll, beforeAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import negotiationModel from "../../app/models/negotiationModel.js";
import { makeRfqVisibleToDashboard, cleanupRfqs } from "../helpers/dashboardSeed.js";

afterAll(async () => {
  await closeDb();
});

const ENDPOINT = "/api/v1/dashboard-v2/negotiation-savings";
const WIDE = { start_date: "2020-01-01", end_date: "2999-01-01" };

const VA = IDS.users.vendor_alpha;
const BUYER = IDS.users.a1_proc_buyer;

// One product variant per scenario so each (vendor, product) pair is
// independently observable.
const V_SINGLE = 1;
const V_RISE = 2;
const V_NOFIRST = 3;

const inserted = { rfqIds: [], roundIds: [] };

afterEach(async () => {
  if (inserted.roundIds.length) {
    await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`, [inserted.roundIds]);
    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [inserted.roundIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_quote_item_history WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  }
  await cleanupRfqs(db, inserted.rfqIds);
  inserted.rfqIds = [];
  inserted.roundIds = [];
});

// ── seed helpers ──────────────────────────────────────────────────────────

async function seedRfq(title) {
  const r = await makeRfqVisibleToDashboard(db, {
    createdBy: BUYER,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
    is_published: 1,
    status: 1,
    title,
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

// The vendor's LIVE quote line. total_price is the CURRENT (already
// negotiated) price; `historyTotal` is the ORIGINAL offer, which is the
// baseline the ladder reaches back to for a first round.
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
     VALUES ($1, $2, $3, $4, 0, 'Ladder line', $5, 0, 0, 0, $5, '1', 'percentage', '', '7')
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

async function addRound(rfq, { number, agoDays, status = "CLOSED" }) {
  const row = await db.one(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, source_type, source_id, round_number, status, end_date, vendor_ids, created_by, created_at)
     VALUES ($1, 'RFQ', $1, $2, $3, now() - ($4 || ' days')::interval, $5::int[], $6,
             now() - ($4 || ' days')::interval)
     RETURNING id`,
    [rfq.id, number, status, String(agoDays), [VA], BUYER]
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

async function readWidget() {
  const res = await client.get(ENDPOINT).query({ hotel_ids: String(IDS.hotels.A1), ...WIDE });
  expect(res.status).toBe(200);
  expect(res.body?.status).toBe(1);
  const d = res.body.data;
  return {
    baseline: Number(d.market_baseline) || 0,
    negotiated: Number(d.negotiated_total) || 0,
    savings: Number(d.total_savings) || 0,
    count: Number(d.negotiation_count) || 0,
  };
}

const delta = (after, before) => ({
  baseline: after.baseline - before.baseline,
  negotiated: after.negotiated - before.negotiated,
  savings: after.savings - before.savings,
  count: after.count - before.count,
});

// ══════════════════════════════════════════════════════════════════════════

describe("dashboard negotiation savings — the baseline ladder", () => {
  it("a SINGLE-round negotiation reports its quote_history saving, not ₹0", async () => {
    const before = await readWidget();

    const rfq = await seedRfq("Ladder single round");
    const rp = await addProduct(rfq, V_SINGLE);
    // Original offer 1000 (history) → negotiated down to 900 in the only round.
    await addQuoteWithHistory(rfq, V_SINGLE, { current: 900, historyTotal: 1000 });
    const r1 = await addRound(rfq, { number: 1, agoDays: 5 });
    await addRoundQuote(r1, rp, 900);

    const d = delta(await readWidget(), before);
    // The old rule compared round 1 with itself and reported exactly zero.
    expect(d.savings).toBeCloseTo(100, 2);
    expect(d.baseline).toBeCloseTo(1000, 2);
    expect(d.negotiated).toBeCloseTo(900, 2);
    expect(d.count).toBe(1);
  });

  it("a price RISE reports a NEGATIVE value — it is never clamped away", async () => {
    const before = await readWidget();

    const rfq = await seedRfq("Ladder price rise");
    const rp = await addProduct(rfq, V_RISE);
    // The vendor came back HIGHER than the original quote.
    await addQuoteWithHistory(rfq, V_RISE, { current: 900, historyTotal: 800 });
    const r1 = await addRound(rfq, { number: 1, agoDays: 4 });
    await addRoundQuote(r1, rp, 900);

    const d = delta(await readWidget(), before);
    expect(d.savings).toBeCloseTo(-100, 2);
    expect(d.baseline).toBeCloseTo(800, 2);
    expect(d.negotiated).toBeCloseTo(900, 2);
  });

  it("a pair on an RFQ with NO round numbered 1 is counted", async () => {
    const before = await readWidget();

    const rfq = await seedRfq("Ladder no round one");
    const rp = await addProduct(rfq, V_NOFIRST);
    // Stored numbers 7 and 8 — exactly what RFQ-wide numbering produces on an
    // RFQ that already had six rounds. No quote item at all, so the ladder
    // falls to the earliest ROUND's own price.
    const r7 = await addRound(rfq, { number: 7, agoDays: 6 });
    const r8 = await addRound(rfq, { number: 8, agoDays: 3 });
    await addRoundQuote(r7, rp, 1000);
    await addRoundQuote(r8, rp, 800);

    const d = delta(await readWidget(), before);
    expect(d.baseline).toBeCloseTo(1000, 2);
    expect(d.negotiated).toBeCloseTo(800, 2);
    expect(d.savings).toBeCloseTo(200, 2);
    expect(d.count).toBe(1);
  });

  it("a CANCELLED round never becomes the achieved anchor", async () => {
    const before = await readWidget();

    const rfq = await seedRfq("Ladder cancelled round");
    const rp = await addProduct(rfq, V_SINGLE);
    await addQuoteWithHistory(rfq, V_SINGLE, { current: 800, historyTotal: 1000 });
    const r1 = await addRound(rfq, { number: 1, agoDays: 6 });
    const rc = await addRound(rfq, { number: 2, agoDays: 2, status: "CANCELLED" });
    await addRoundQuote(r1, rp, 800);
    await addRoundQuote(rc, rp, 100); // absurd; must be ignored

    const d = delta(await readWidget(), before);
    expect(d.negotiated).toBeCloseTo(800, 2);
    expect(d.savings).toBeCloseTo(200, 2);
  });

  it("the widget reconciles exactly with negotiationModel.getNegotiationParentSavings", async () => {
    const before = await readWidget();

    // Three RFQs at once — a single-round saver, a riser, and a pair with no
    // round numbered 1. The widget total must equal the negotiation module's
    // own figure over the same ids, to the rupee, including the negative.
    const a = await seedRfq("Reconcile A");
    const rpA = await addProduct(a, V_SINGLE);
    await addQuoteWithHistory(a, V_SINGLE, { current: 900, historyTotal: 1000 });
    const ra = await addRound(a, { number: 1, agoDays: 5 });
    await addRoundQuote(ra, rpA, 900);

    const b = await seedRfq("Reconcile B");
    const rpB = await addProduct(b, V_RISE);
    await addQuoteWithHistory(b, V_RISE, { current: 900, historyTotal: 800 });
    const rb = await addRound(b, { number: 1, agoDays: 5 });
    await addRoundQuote(rb, rpB, 900);

    const c = await seedRfq("Reconcile C");
    const rpC = await addProduct(c, V_NOFIRST);
    const rc1 = await addRound(c, { number: 7, agoDays: 6 });
    const rc2 = await addRound(c, { number: 8, agoDays: 3 });
    await addRoundQuote(rc1, rpC, 1000);
    await addRoundQuote(rc2, rpC, 800);

    const d = delta(await readWidget(), before);

    const rows = await negotiationModel.getNegotiationParentSavings([a.id, b.id, c.id]);
    const sum = (k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
    const modelBaseline = sum("baseline_total");
    const modelAchieved = sum("achieved_total");

    expect(d.baseline).toBeCloseTo(modelBaseline, 2);
    expect(d.negotiated).toBeCloseTo(modelAchieved, 2);
    expect(d.savings).toBeCloseTo(modelBaseline - modelAchieved, 2);
    // 100 (A) − 100 (B) + 200 (C).
    expect(d.savings).toBeCloseTo(200, 2);
    expect(d.count).toBe(sum("pairs_counted"));
  });
});
