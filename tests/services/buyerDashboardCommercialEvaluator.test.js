// Wave-style integration test for the Commercial Evaluator (N1) dashboard widgets.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  insertVendorQuote,
} from "../helpers/dashboardSeed.js";

const inserted = { rfqIds: [], roundIds: [] };
const seeded = {};

beforeAll(async () => {
  await db.tx(async (t) => {
    // ── Quote-compare stage RFQs at A1 ─────────────────────────────
    // Has quote, no negotiation, no PO → counts as quote-compare.
    const qc1 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "QC RFQ Alpha",
    });
    await insertVendorQuote(t, { rfq_id: qc1.rfq_id, vendor_user_id: IDS.users.vendor_alpha });

    const qc2 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "QC RFQ Bravo",
    });
    await insertVendorQuote(t, { rfq_id: qc2.rfq_id, vendor_user_id: IDS.users.vendor_alpha });
    await insertVendorQuote(t, { rfq_id: qc2.rfq_id, vendor_user_id: IDS.users.vendor_beta });

    // RFQ with quote AND active negotiation — should NOT appear in QC widget.
    const qcWithNeg = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "Negotiating",
    });
    await insertVendorQuote(t, { rfq_id: qcWithNeg.rfq_id, vendor_user_id: IDS.users.vendor_alpha });

    // RFQ with no quotes — must NOT be in QC widget.
    const qcNoQuotes = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "No quotes",
    });

    // RFQ in QC stage at A2 — wrong hotel.
    const qcA2 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A2,
      status: 1, is_published: 1, title: "QC at A2",
    });
    await insertVendorQuote(t, { rfq_id: qcA2.rfq_id, vendor_user_id: IDS.users.vendor_alpha });

    // ── Active negotiation led by a1_proc_commEval ─────────────────
    const negRfq1 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "Active Negotiation 1",
    });
    const round1 = await t.one(
      `INSERT INTO tbl_negotiation_rounds
        (rfq_id, round_number, status, created_by, end_date, vendor_ids)
       VALUES ($1, 1, 'ACTIVE', $2, NOW() + INTERVAL '2 days', ARRAY[$3, $4, $5]::int[])
       RETURNING id`,
      [
        negRfq1.rfq_id,
        IDS.users.a1_proc_commEval,
        IDS.users.vendor_alpha,
        IDS.users.vendor_beta,
        IDS.users.vendor_gamma,
      ]
    );
    // Vendor alpha responded; beta + gamma silent.
    await t.none(
      `INSERT INTO tbl_negotiation_round_quotes
         (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, submitted_at)
       VALUES ($1, $2, NULL, 1000, NOW())`,
      [round1.id, IDS.users.vendor_alpha]
    );

    const negRfq2 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "Active Negotiation 2",
    });
    const round2 = await t.one(
      `INSERT INTO tbl_negotiation_rounds
        (rfq_id, round_number, status, created_by, end_date, vendor_ids)
       VALUES ($1, 1, 'ACTIVE', $2, NOW() + INTERVAL '5 days', ARRAY[$3, $4]::int[])
       RETURNING id`,
      [
        negRfq2.rfq_id,
        IDS.users.a1_proc_commEval,
        IDS.users.vendor_alpha,
        IDS.users.vendor_beta,
      ]
    );
    // No vendor has responded — both silent.

    // CLOSED round led by user — must NOT appear in active list.
    const closedRound = await t.one(
      `INSERT INTO tbl_negotiation_rounds
        (rfq_id, round_number, status, created_by, end_date, vendor_ids)
       VALUES ($1, 1, 'CLOSED', $2, NOW() - INTERVAL '1 day', ARRAY[$3]::int[])
       RETURNING id`,
      [qcWithNeg.rfq_id, IDS.users.a1_proc_commEval, IDS.users.vendor_alpha]
    );

    // Active round by ANOTHER user — must NOT appear for commEval.
    const otherRound = await t.one(
      `INSERT INTO tbl_negotiation_rounds
        (rfq_id, round_number, status, created_by, end_date, vendor_ids)
       VALUES ($1, 2, 'ACTIVE', $2, NOW() + INTERVAL '1 day', ARRAY[$3]::int[])
       RETURNING id`,
      [qcWithNeg.rfq_id, IDS.users.a1_proc_buyer, IDS.users.vendor_alpha]
    );

    // Active round at A2 — must NOT appear when filtering A1.
    const a2NegRfq = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A2,
      status: 1, is_published: 1, title: "Neg at A2",
    });
    const a2Round = await t.one(
      `INSERT INTO tbl_negotiation_rounds
        (rfq_id, round_number, status, created_by, end_date, vendor_ids)
       VALUES ($1, 1, 'ACTIVE', $2, NOW() + INTERVAL '3 days', ARRAY[$3]::int[])
       RETURNING id`,
      [a2NegRfq.rfq_id, IDS.users.a1_proc_commEval, IDS.users.vendor_alpha]
    );

    // ── Completed negotiation chains for savings pipeline ───────────
    //
    // RFQ A: round 1 had 1 vendor × 1 product at ₹1000. Round 2 (last)
    // dropped to ₹800. Savings = 200. Closed in last 30 days.
    const savRfq = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "Savings demo RFQ",
    });
    const r1Saved = await t.one(
      `INSERT INTO tbl_negotiation_rounds
        (rfq_id, round_number, status, created_by, end_date, closed_at, vendor_ids)
       VALUES ($1, 1, 'CLOSED', $2, NOW() - INTERVAL '10 days', NOW() - INTERVAL '8 days',
               ARRAY[$3]::int[])
       RETURNING id`,
      [savRfq.rfq_id, IDS.users.a1_proc_commEval, IDS.users.vendor_alpha]
    );
    const r2Saved = await t.one(
      `INSERT INTO tbl_negotiation_rounds
        (rfq_id, round_number, status, created_by, end_date, closed_at, vendor_ids)
       VALUES ($1, 2, 'CLOSED', $2, NOW() - INTERVAL '7 days', NOW() - INTERVAL '5 days',
               ARRAY[$3]::int[])
       RETURNING id`,
      [savRfq.rfq_id, IDS.users.a1_proc_commEval, IDS.users.vendor_alpha]
    );
    // Use a fixed rfq_product_id reference so DISTINCT ON groups them.
    // Add a tbl_rfq_products row to satisfy the join.
    const variant = await t.one(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 1`);
    const rfqProd = await t.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
       VALUES ($1, '', '0', '', '', $2, 1) RETURNING id`,
      [savRfq.rfq_id, variant.id]
    );
    await t.none(
      `INSERT INTO tbl_negotiation_round_quotes
         (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, submitted_at)
       VALUES ($1, $2, $3, 1000, NOW() - INTERVAL '9 days')`,
      [r1Saved.id, IDS.users.vendor_alpha, rfqProd.id]
    );
    await t.none(
      `INSERT INTO tbl_negotiation_round_quotes
         (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, submitted_at)
       VALUES ($1, $2, $3, 800, NOW() - INTERVAL '6 days')`,
      [r2Saved.id, IDS.users.vendor_alpha, rfqProd.id]
    );

    inserted.rfqIds = [
      qc1.rfq_id, qc2.rfq_id, qcWithNeg.rfq_id, qcNoQuotes.rfq_id,
      qcA2.rfq_id, negRfq1.rfq_id, negRfq2.rfq_id, a2NegRfq.rfq_id,
      savRfq.rfq_id,
    ];
    inserted.roundIds = [
      round1.id, round2.id, closedRound.id, otherRound.id,
      a2Round.id, r1Saved.id, r2Saved.id,
    ];

    seeded.qc1 = qc1.rfq_id;
    seeded.qc2 = qc2.rfq_id;
    seeded.qcWithNeg = qcWithNeg.rfq_id;
    seeded.qcA2 = qcA2.rfq_id;
    seeded.activeRound1 = round1.id;
    seeded.activeRound2 = round2.id;
    seeded.closedRound = closedRound.id;
    seeded.otherUserRound = otherRound.id;
    seeded.a2Round = a2Round.id;
    seeded.savRfq = savRfq.rfq_id;
  });
});

afterAll(async () => {
  // Order matters — quotes reference rounds.
  await db.none(
    `DELETE FROM tbl_negotiation_round_quotes
     WHERE negotiation_round_id = ANY($1)`,
    [inserted.roundIds]
  );
  await db.none(
    `DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1)`,
    [inserted.roundIds]
  );
  // Cleanup rfq_products created for the savings RFQ.
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1)`, [inserted.rfqIds]);
  await cleanupRfqs(db, inserted.rfqIds);
  await closeDb();
});

describe("Buyer Dashboard — Commercial Evaluator / N1 widgets (real data)", () => {
  /* ────────── /my-quote-compares ───────── */

  it("returns exactly the RFQs in quote-compare stage at A1", async () => {
    const client = await httpClient(IDS.users.a1_proc_commEval);
    const res = await client
      .get("/api/v1/dashboard-v2/my-quote-compares")
      .query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.count).toBe(2);

    const ids = res.body.data.items.map((i) => i.id).sort();
    expect(ids).toEqual([seeded.qc1, seeded.qc2].sort());

    // qc2 has 2 distinct vendors quoted; qc1 has 1.
    const byId = {};
    for (const item of res.body.data.items) byId[item.id] = item;
    expect(byId[seeded.qc1].vendor_count).toBe(1);
    expect(byId[seeded.qc2].vendor_count).toBe(2);

    // qcWithNeg (has active neg), qcNoQuotes (no quotes), qcA2 (wrong hotel) excluded.
    expect(ids).not.toContain(seeded.qcWithNeg);
    expect(ids).not.toContain(seeded.qcA2);
  });

  /* ────────── /my-active-negotiations ───────── */

  it("returns active rounds led by user with accurate silent-vendor counts", async () => {
    const client = await httpClient(IDS.users.a1_proc_commEval);
    const res = await client
      .get("/api/v1/dashboard-v2/my-active-negotiations")
      .query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);
    // round1: 3 invited, 1 responded → 2 silent
    // round2: 2 invited, 0 responded → 2 silent
    expect(res.body.data.total_silent_vendors).toBe(4);

    const byId = {};
    for (const item of res.body.data.items) byId[item.id] = item;
    expect(byId[seeded.activeRound1].silent_vendor_count).toBe(2);
    expect(byId[seeded.activeRound2].silent_vendor_count).toBe(2);

    // CLOSED rounds and rounds by other users do NOT appear.
    expect(byId[seeded.closedRound]).toBeUndefined();
    expect(byId[seeded.otherUserRound]).toBeUndefined();
    // A2-scoped round excluded by hotel filter.
    expect(byId[seeded.a2Round]).toBeUndefined();
  });

  /* ────────── /savings-pipeline ───────── */

  it("computes accurate cumulative ₹ savings from negotiations led by user", async () => {
    const client = await httpClient(IDS.users.a1_proc_commEval);
    const res = await client
      .get("/api/v1/dashboard-v2/savings-pipeline")
      .query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    // Round 1: 1000, Round 2 (last): 800 → savings 200.
    expect(res.body.data.total_savings).toBe(200);
    expect(res.body.data.negotiation_count).toBe(1);
    // 200/1000 = 20% avg savings.
    expect(res.body.data.avg_savings_pct).toBe(20);
    expect(res.body.data.prior_period_savings).toBe(0);
  });

  /* ────────── Scope isolation ───────── */

  it("Hotel B user sees zero Commercial Evaluator widgets", async () => {
    const client = await httpClient(IDS.users.companyB_admin);
    const [qc, neg, sav] = await Promise.all([
      client.get("/api/v1/dashboard-v2/my-quote-compares").query({ hotel_ids: String(IDS.hotels.B1) }),
      client.get("/api/v1/dashboard-v2/my-active-negotiations").query({ hotel_ids: String(IDS.hotels.B1) }),
      client.get("/api/v1/dashboard-v2/savings-pipeline").query({ hotel_ids: String(IDS.hotels.B1) }),
    ]);
    expect(qc.body.data.count).toBe(0);
    expect(neg.body.data.count).toBe(0);
    expect(sav.body.data.total_savings).toBe(0);
    expect(sav.body.data.negotiation_count).toBe(0);
  });
});
