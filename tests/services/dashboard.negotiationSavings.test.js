// Integration tests for GET /api/v1/dashboard-v2/negotiation-savings.
//
// Savings = baseline − final-round quoted price, per vendor+product across RFQs
// that had negotiation rounds in the window. D2: the HEADLINE is the AWARDED
// (realised) saving — only the vendor whose NEGOTIATION_QUOTE was approved;
// the all-vendor figure is returned as `all_vendors`. Client feedback Sr 240
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
  makeApprovalInstanceWithApprover,
  cleanupApprovalInstances,
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

const allVendors = (d) => d.all_vendors;

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
    expect(allVendors(after).market_baseline - allVendors(before).market_baseline).toBeCloseTo(1000, 1);
    expect(allVendors(after).negotiated_total - allVendors(before).negotiated_total).toBeCloseTo(900, 1);
    expect(allVendors(after).total_savings - allVendors(before).total_savings).toBeCloseTo(100, 1);
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
    expect(allVendors(after).market_baseline - allVendors(before).market_baseline).toBeCloseTo(0, 1);
    expect(allVendors(after).negotiated_total - allVendors(before).negotiated_total).toBeCloseTo(0, 1);
    expect(allVendors(after).total_savings - allVendors(before).total_savings).toBeCloseTo(0, 1);
  });
});

describe("GET /dashboard-v2/negotiation-savings — headline is the AWARDED saving (D2)", () => {
  const approvals = [];
  afterEach(async () => {
    if (approvals.length) {
      await cleanupApprovalInstances(db, "NEGOTIATION_QUOTE", approvals.splice(0));
    }
  });

  it("counts only the approved vendor's cut in the headline; all_vendors keeps both", async () => {
    const before = await fetchSavings();

    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1,
      title: "Awarded savings RFQ",
    });
    inserted.rfqIds.push(rfq_id);
    const { rfq_product_id } = await addProductToRfq(db, rfq_id);

    // Winner cut 1000 -> 900; loser cut 1000 -> 700 (bigger cut, but lost).
    await seedNegotiation(rfq_id, rfq_product_id, { r1Price: 1000, r2Price: 900, vendor_id: IDS.users.vendor_alpha });
    await seedNegotiation(rfq_id, rfq_product_id, { r1Price: 1000, r2Price: 700, vendor_id: IDS.users.vendor_beta });

    // Prod shape (SPEC rule 6): NEGOTIATION_QUOTE.entity_id = tbl_rfq_products.id.
    await db.tx(async (t) => {
      const inst = await makeApprovalInstanceWithApprover(t, {
        entity_type: "NEGOTIATION_QUOTE",
        entity_id: rfq_product_id,
        approver_user_id: IDS.users.a1_proc_commApp,
        policy_id: IDS.policies.A1_P1_NEGOTIATION_QUOTE,
        hospitality: IDS.hospitality.A,
        hotel: IDS.hotels.A1,
        instance_status: "APPROVED",
        approver_status: "APPROVED",
        acted_ago_hours: 1,
      });
      await t.none(
        `UPDATE tbl_approval_instances SET metadata = $2::jsonb WHERE id = $1`,
        [inst.instance_id, JSON.stringify({ rfq_id, vendor_id: IDS.users.vendor_alpha })]
      );
    });
    approvals.push(rfq_product_id);

    const after = await fetchSavings();
    expect(after.basis).toBe("awarded");
    expect(after.total_savings - before.total_savings).toBeCloseTo(100, 1);
    expect(after.awarded.total_savings - before.awarded.total_savings).toBeCloseTo(100, 1);
    expect(allVendors(after).total_savings - allVendors(before).total_savings).toBeCloseTo(400, 1);
  });
});
