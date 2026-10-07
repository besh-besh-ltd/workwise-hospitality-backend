// Integration test for the Commercial Evaluator (N1) dashboard widgets, with
// PRODUCTION-shaped rounds: prod carries ENDED / EXPIRED / CANCELLED /
// COMPLETED / PENDING_APPROVAL / ACTIVE and never 'CLOSED', which is why the
// old `status NOT IN ('CLOSED', …)` test treated every ended round as live.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import moment from "moment-timezone";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  insertVendorQuote,
  makeApprovalInstanceWithApprover,
  cleanupApprovalInstances,
} from "../helpers/dashboardSeed.js";

const inserted = { rfqIds: [], roundIds: [], nqEntityIds: [] };
const seeded = {};

const istDateTime = (offsetDays) =>
  moment.tz("Asia/Kolkata").add(offsetDays, "days").format("YYYY-MM-DDTHH:mm");
const istDate = (offsetDays) =>
  moment.tz("Asia/Kolkata").add(offsetDays, "days").format("YYYY-MM-DD");

async function rfq(t, title, { hotel = IDS.hotels.A1, bidDays = -2 } = {}) {
  const r = await makeRfqVisibleToDashboard(t, {
    createdBy: IDS.users.a1_proc_buyer,
    hospitality: IDS.hospitality.A, hotel,
    status: 1, is_published: 1, title,
    bid_end_date: istDateTime(bidDays),
  });
  inserted.rfqIds.push(r.rfq_id);
  return r.rfq_id;
}

async function round(t, rfqId, { status, by = IDS.users.a1_proc_commEval, endSql, closedSql = "NULL", vendors = [IDS.users.vendor_alpha], n = 1 }) {
  const r = await t.one(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, round_number, status, created_by, end_date, closed_at, vendor_ids)
     VALUES ($1, $2, $3, $4, ${endSql}, ${closedSql}, $5::int[])
     RETURNING id`,
    [rfqId, n, status, by, vendors]
  );
  inserted.roundIds.push(r.id);
  return r.id;
}

/** A priced two-round negotiation on one product, awarded to vendor_alpha. */
async function awardedNegotiation(t, title, { first, last, concludedDaysAgo }) {
  const rfqId = await rfq(t, title, { bidDays: -(concludedDaysAgo + 10) });
  const variant = await t.one(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 1`);
  const rp = await t.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
     VALUES ($1, '', '0', '', '', $2, 1) RETURNING id`,
    [rfqId, variant.id]
  );
  const utc = (d) => `((now() AT TIME ZONE 'UTC') - INTERVAL '${d} days')`;
  const r1 = await round(t, rfqId, { status: "ENDED", endSql: utc(concludedDaysAgo + 5), closedSql: `(now() - INTERVAL '${concludedDaysAgo + 3} days')` });
  const r2 = await round(t, rfqId, { status: "ENDED", n: 2, endSql: utc(concludedDaysAgo + 2), closedSql: `(now() - INTERVAL '${concludedDaysAgo} days')` });
  await t.none(
    `INSERT INTO tbl_negotiation_round_quotes (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, submitted_at)
     VALUES ($1, $3, $4, $5, now() - INTERVAL '20 days'), ($2, $3, $4, $6, now() - INTERVAL '19 days')`,
    [r1, r2, IDS.users.vendor_alpha, rp.id, first, last]
  );
  // The quote the approver approved — what makes this saving "awarded" (D2).
  await makeApprovalInstanceWithApprover(t, {
    entity_type: "NEGOTIATION_QUOTE", entity_id: rp.id,
    approver_user_id: IDS.users.a1_proc_commApp,
    policy_id: IDS.policies.A1_P1_NEGOTIATION_QUOTE,
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
    instance_status: "APPROVED", approver_status: "APPROVED", acted_ago_hours: 24,
    metadata: { rfq_id: rfqId, rfq_product_id: rp.id, vendor_id: IDS.users.vendor_alpha },
  });
  inserted.nqEntityIds.push(rp.id);
  return rfqId;
}

beforeAll(async () => {
  await db.tx(async (t) => {
    // ── Ready for quote comparison (lifecycle COMMERCIAL_EVALUATION) ──
    const qc1 = await rfq(t, "QC Alpha", { bidDays: -3 });
    await insertVendorQuote(t, { rfq_id: qc1, vendor_user_id: IDS.users.vendor_alpha });
    const qc2 = await rfq(t, "QC Bravo", { bidDays: -2 });
    await insertVendorQuote(t, { rfq_id: qc2, vendor_user_id: IDS.users.vendor_alpha });
    await insertVendorQuote(t, { rfq_id: qc2, vendor_user_id: IDS.users.vendor_beta });
    // An ENDED round does not make an RFQ "in negotiation" — still comparable.
    const qcEnded = await rfq(t, "QC after an ended round", { bidDays: -1 });
    await insertVendorQuote(t, { rfq_id: qcEnded, vendor_user_id: IDS.users.vendor_alpha });
    await round(t, qcEnded, { status: "ENDED", endSql: "((now() AT TIME ZONE 'UTC') - INTERVAL '1 hour')" });

    // ── NOT ready ─────────────────────────────────────────────────────
    const qcLiveRound = await rfq(t, "Live round");
    await insertVendorQuote(t, { rfq_id: qcLiveRound, vendor_user_id: IDS.users.vendor_alpha });
    const otherRound = await round(t, qcLiveRound, {
      status: "ACTIVE", by: IDS.users.a1_proc_buyer,
      endSql: "((now() AT TIME ZONE 'UTC') + INTERVAL '1 day')",
    });
    const qcBidOpen = await rfq(t, "Bid still open", { bidDays: 3 });
    await insertVendorQuote(t, { rfq_id: qcBidOpen, vendor_user_id: IDS.users.vendor_alpha });
    const qcRegret = await rfq(t, "Regret only");
    const regretId = await insertVendorQuote(t, { rfq_id: qcRegret, vendor_user_id: IDS.users.vendor_alpha });
    await t.none(`UPDATE tbl_quotes SET is_regret = 1 WHERE id = $1`, [regretId]);
    const qcA2 = await rfq(t, "QC at A2", { hotel: IDS.hotels.A2 });
    await insertVendorQuote(t, { rfq_id: qcA2, vendor_user_id: IDS.users.vendor_alpha });
    // A tender otherwise ready for comparison: tenders are compared in ARC,
    // and the RFQ list the "View all" link opens excludes them.
    const qcTender = await rfq(t, "Tender ready to compare", { bidDays: -4 });
    await insertVendorQuote(t, { rfq_id: qcTender, vendor_user_id: IDS.users.vendor_alpha });
    await t.none(`UPDATE tbl_rfq SET is_tender = 1 WHERE id = $1`, [qcTender]);

    // ── Live rounds led by commEval ───────────────────────────────────
    const negRfq1 = await rfq(t, "Active Negotiation 1", { bidDays: -5 });
    const activeRound1 = await round(t, negRfq1, {
      status: "ACTIVE", endSql: "((now() AT TIME ZONE 'UTC') + INTERVAL '2 days')",
      vendors: [IDS.users.vendor_alpha, IDS.users.vendor_beta, IDS.users.vendor_gamma],
    });
    await t.none(
      `INSERT INTO tbl_negotiation_round_quotes (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, submitted_at)
       VALUES ($1, $2, NULL, 1000, now())`,
      [activeRound1, IDS.users.vendor_alpha]
    );
    const negRfq2 = await rfq(t, "Active Negotiation 2", { bidDays: -5 });
    const activeRound2 = await round(t, negRfq2, {
      status: "ACTIVE", endSql: "((now() AT TIME ZONE 'UTC') + INTERVAL '5 days')",
      vendors: [IDS.users.vendor_alpha, IDS.users.vendor_beta],
    });
    const pendingRound = await round(t, negRfq2, {
      status: "PENDING_APPROVAL", n: 2, endSql: "((now() AT TIME ZONE 'UTC') + INTERVAL '6 days')",
    });
    const endedRound = await round(t, negRfq1, { status: "ENDED", n: 2, endSql: "((now() AT TIME ZONE 'UTC') - INTERVAL '1 day')" });
    // ACTIVE on paper but the vendor window already passed.
    const expiredActive = await round(t, negRfq1, { status: "ACTIVE", n: 3, endSql: "((now() AT TIME ZONE 'UTC') - INTERVAL '1 hour')" });
    const negA2 = await rfq(t, "Neg at A2", { hotel: IDS.hotels.A2, bidDays: -5 });
    const a2Round = await round(t, negA2, { status: "ACTIVE", endSql: "((now() AT TIME ZONE 'UTC') + INTERVAL '3 days')" });

    // ── Savings pipeline ──────────────────────────────────────────────
    // Concluded 5 days ago: ₹1000 → ₹800 (saved 200).
    const savRecent = await awardedNegotiation(t, "Savings recent", { first: 1000, last: 800, concludedDaysAgo: 5 });
    // Concluded 45 days ago: ₹500 → ₹450 (saved 50) — the PRIOR 30-day window.
    const savPrior = await awardedNegotiation(t, "Savings prior", { first: 500, last: 450, concludedDaysAgo: 45 });

    Object.assign(seeded, {
      qc1, qc2, qcEnded, qcLiveRound, qcBidOpen, qcRegret, qcA2, qcTender,
      activeRound1, activeRound2, pendingRound, endedRound, expiredActive, otherRound, a2Round,
      savRecent, savPrior,
    });
  });
});

afterAll(async () => {
  await cleanupApprovalInstances(db, "NEGOTIATION_QUOTE", inserted.nqEntityIds);
  await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1)`, [inserted.roundIds]);
  await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1)`, [inserted.roundIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1)`, [inserted.rfqIds]);
  await cleanupRfqs(db, inserted.rfqIds);
  await closeDb();
});

describe("Buyer Dashboard — Commercial Evaluator / N1 widgets (real data)", () => {
  it("lists exactly the RFQs the lifecycle puts in Commercial Evaluation, oldest bid close first", async () => {
    const client = await httpClient(IDS.users.a1_proc_commEval);
    const res = await client.get("/api/v1/dashboard-v2/my-quote-compares").query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    const ids = res.body.data.items.map((i) => i.id);
    expect(ids).toEqual([seeded.qc1, seeded.qc2, seeded.qcEnded]);
    expect(res.body.data.count).toBe(3);

    for (const excluded of [seeded.qcLiveRound, seeded.qcBidOpen, seeded.qcRegret, seeded.qcA2, seeded.qcTender]) {
      expect(ids).not.toContain(excluded);
    }
    const qc2 = res.body.data.items.find((i) => i.id === seeded.qc2);
    expect(qc2.vendor_count).toBe(2);
    expect(qc2.bid_closed_at).toBeTruthy();
  });

  it("lists my live rounds — open ACTIVE ones first, then those awaiting approval", async () => {
    const client = await httpClient(IDS.users.a1_proc_commEval);
    const res = await client.get("/api/v1/dashboard-v2/my-active-negotiations").query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    const ids = res.body.data.items.map((i) => i.id);
    expect(ids).toEqual([seeded.activeRound1, seeded.activeRound2, seeded.pendingRound]);
    expect(res.body.data.count).toBe(3);
    expect(res.body.data.awaiting_approval_count).toBe(1);
    // 2 silent on round 1 (beta, gamma) + 2 on round 2.
    expect(res.body.data.total_silent_vendors).toBe(4);

    const byId = Object.fromEntries(res.body.data.items.map((i) => [i.id, i]));
    expect(byId[seeded.activeRound1].silent_vendor_count).toBe(2);
    expect(byId[seeded.pendingRound].round_status).toBe("PENDING_APPROVAL");
    expect(byId[seeded.pendingRound].silent_vendor_count).toBeNull();

    for (const excluded of [seeded.endedRound, seeded.expiredActive, seeded.otherRound, seeded.a2Round]) {
      expect(ids).not.toContain(excluded);
    }
  });

  it("savings pipeline: awarded savings of negotiations concluded in the window, vs the prior window", async () => {
    const client = await httpClient(IDS.users.a1_proc_commEval);
    const res = await client.get("/api/v1/dashboard-v2/savings-pipeline").query({
      hotel_ids: String(IDS.hotels.A1), start_date: istDate(-29), end_date: istDate(0),
    });

    expect(res.status).toBe(200);
    expect(res.body.data.basis).toBe("awarded");
    expect(res.body.data.total_savings).toBe(200);
    expect(res.body.data.negotiation_count).toBe(1);
    expect(res.body.data.avg_savings_pct).toBe(20);
    expect(res.body.data.prior_period_savings).toBe(50);
    expect(res.body.data.window).toEqual({ start_date: istDate(-29), end_date: istDate(0) });
    expect(res.body.data.prior_window).toEqual({ start_date: istDate(-59), end_date: istDate(-30) });
  });

  it("savings pipeline with no range (All) covers every concluded negotiation and has no prior window", async () => {
    const client = await httpClient(IDS.users.a1_proc_commEval);
    const res = await client.get("/api/v1/dashboard-v2/savings-pipeline").query({ hotel_ids: String(IDS.hotels.A1) });
    expect(res.body.data.total_savings).toBe(250);
    expect(res.body.data.negotiation_count).toBe(2);
    expect(res.body.data.prior_period_savings).toBeNull();
    expect(res.body.data.prior_window).toBeNull();
  });

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
