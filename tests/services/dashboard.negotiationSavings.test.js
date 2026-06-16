// Integration tests for GET /api/v1/dashboard-v2/negotiation-savings.
//
// Savings = round-1 quoted price − final-round quoted price, per vendor+product
// across RFQs that had negotiation rounds in the window. Client feedback Sr 240
// requires Terminated/Rejected RFQs to be EXCLUDED from the calculation. We
// treat WITHDRAWN (status=5) as the terminated/rejected-by-us state.
//
// Product-level tests over real HTTP, measuring DELTAS against a baseline so
// they survive a shared seed DB.

import { describe, it, expect, afterAll, beforeEach, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  addProductToRfq,
} from "../helpers/dashboardSeed.js";

afterAll(async () => {
  await closeDb();
});

const ENDPOINT = "/api/v1/dashboard-v2/negotiation-savings";
const WIDE = { start_date: "2020-01-01", end_date: "2999-01-01" };

const inserted = { rfqIds: [] };

beforeEach(() => {
  inserted.rfqIds = [];
});

afterEach(async () => {
  // Negotiation rows are not covered by cleanupRfqs — remove them first.
  if (inserted.rfqIds.length) {
    await db.none(
      `DELETE FROM tbl_negotiation_round_quotes
       WHERE negotiation_round_id IN (
         SELECT id FROM tbl_negotiation_rounds WHERE rfq_id = ANY($1)
       )`,
      [inserted.rfqIds]
    );
    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE rfq_id = ANY($1)`, [inserted.rfqIds]);
  }
  await cleanupRfqs(db, inserted.rfqIds);
});

// Seed a 2-round negotiation for one vendor+product: round 1 @ r1Price, round 2
// @ r2Price (the final price). Returns nothing — savings = r1Price - r2Price.
async function seedNegotiation(rfq_id, rfq_product_id, { r1Price, r2Price, vendor_id }) {
  for (const [roundNo, price] of [[1, r1Price], [2, r2Price]]) {
    const round = await db.one(
      `INSERT INTO tbl_negotiation_rounds (rfq_id, round_number, end_date, status, created_by, created_at)
       VALUES ($1, $2, now() + interval '1 day', 'CLOSED', $3, now())
       RETURNING id`,
      [rfq_id, roundNo, IDS.users.a1_proc_buyer]
    );
    await db.none(
      `INSERT INTO tbl_negotiation_round_quotes (negotiation_round_id, vendor_id, rfq_product_id, quoted_price)
       VALUES ($1, $2, $3, $4)`,
      [round.id, vendor_id, rfq_product_id, price]
    );
  }
}

async function fetchSavings() {
  const client = await httpClient(IDS.users.a1_proc_buyer);
  const res = await client.get(ENDPOINT).query({ hotel_ids: String(IDS.hotels.A1), ...WIDE });
  expect(res.status).toBe(200);
  expect(res.body?.status).toBe(1);
  return res.body.data;
}

describe("GET /dashboard-v2/negotiation-savings — counts a live RFQ's negotiation", () => {
  it("includes round1 vs final-round delta for an OPEN RFQ", async () => {
    const before = await fetchSavings();

    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1,
      title: "Negotiated OPEN RFQ",
    });
    inserted.rfqIds.push(rfq_id);
    const { rfq_product_id } = await addProductToRfq(db, rfq_id);
    await seedNegotiation(rfq_id, rfq_product_id, {
      r1Price: 1000,
      r2Price: 900,
      vendor_id: IDS.users.vendor_alpha,
    });

    const after = await fetchSavings();
    expect(after.market_baseline - before.market_baseline).toBeCloseTo(1000, 1);
    expect(after.negotiated_total - before.negotiated_total).toBeCloseTo(900, 1);
    expect(after.total_savings - before.total_savings).toBeCloseTo(100, 1);
  });
});

describe("GET /dashboard-v2/negotiation-savings — excludes terminated/rejected (Sr 240)", () => {
  it("does NOT count negotiation savings for a WITHDRAWN RFQ", async () => {
    const before = await fetchSavings();

    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 5, // WITHDRAWN — terminated/rejected by us
      title: "Withdrawn negotiated RFQ",
    });
    inserted.rfqIds.push(rfq_id);
    const { rfq_product_id } = await addProductToRfq(db, rfq_id);
    await seedNegotiation(rfq_id, rfq_product_id, {
      r1Price: 1000,
      r2Price: 900,
      vendor_id: IDS.users.vendor_alpha,
    });

    const after = await fetchSavings();
    expect(after.market_baseline - before.market_baseline).toBeCloseTo(0, 1);
    expect(after.negotiated_total - before.negotiated_total).toBeCloseTo(0, 1);
    expect(after.total_savings - before.total_savings).toBeCloseTo(0, 1);
  });
});
