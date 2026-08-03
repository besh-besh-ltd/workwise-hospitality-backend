// Integration tests for GET /api/v1/dashboard-v2/buyer-status-banner.
//
// The endpoint is a single BFF aggregator that drives the hero strip at
// the top of /dashboard/buyer. It returns:
//   { mode, counts, soonest_closing, weekly, greeting }
// where `mode` is derived server-side from the counts so the FE never
// needs to recompute severity.
//
// Tests assert observable behaviour over real HTTP against the local
// Postgres seed (per CLAUDE.md product-level test rules):
//   1. clear        — no pending work, no closing soon, no bid-window losses
//   2. steady       — some PO awaiting acceptance / quote-compare ready
//   3. action_needed — RFQ closes within 24h
//   4. critical    — RFQ ended with zero quotes
//   5. counts respect the bid_end_date / created_by scope
//   6. greeting.first_name is returned

import { describe, it, expect, afterAll, beforeEach, afterEach } from "@jest/globals";
import moment from "moment-timezone";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  cleanupApprovalInstances,
  makeApprovalInstanceWithApprover,
  makePO,
  cleanupPurchaseOrders,
} from "../helpers/dashboardSeed.js";

afterAll(async () => {
  await closeDb();
});

const ENDPOINT = "/api/v1/dashboard-v2/buyer-status-banner";

// Helper — `now + offsetMs` as a NAIVE IST wall-clock string, the exact shape
// `tbl_rfq.bid_end_date` (text) holds in production.
//
// This used to be `new Date(Date.now() + off).toISOString()`, which writes a
// UTC wall clock into a column the whole application reads as IST — a built-in
// 5h30m lie that made every offset here mean something 5.5 hours other than
// what it says, and made the suite unable to see the boundary bug it is now
// pinning. Precedent: tests/services/buyerDashboardRfqCreator.test.js.
function offsetString(offsetMs) {
  return moment.tz("Asia/Kolkata").add(offsetMs, "ms").format("YYYY-MM-DD HH:mm:ss");
}

// Track everything we seed for cleanup. Scoped per describe block; reset in
// beforeEach so each test starts from a known-clean state.
const inserted = { rfqIds: [], poIds: [], approvalEntityIds: [] };

beforeEach(() => {
  inserted.rfqIds = [];
  inserted.poIds = [];
  inserted.approvalEntityIds = [];
});

afterEach(async () => {
  // Reverse FK order: POs → approvals → RFQ child rows + RFQs.
  await cleanupPurchaseOrders(db, inserted.poIds);
  if (inserted.approvalEntityIds.length > 0) {
    // The seed helper attaches approvals to mixed entity types — clean by
    // both common types used in this suite.
    await cleanupApprovalInstances(db, "RFQ", inserted.approvalEntityIds);
    await cleanupApprovalInstances(db, "PO", inserted.approvalEntityIds);
  }
  await cleanupRfqs(db, inserted.rfqIds);
});

describe("GET /dashboard-v2/buyer-status-banner — auth", () => {
  it("returns 401/403 without a JWT", async () => {
    const client = await httpClient(null);
    const res = await client.get(ENDPOINT);
    expect([401, 403]).toContain(res.status);
  });

  it("returns 403 when the user has no hospitality access", async () => {
    const client = await httpClient(IDS.users.superAdmin);
    const res = await client.get(ENDPOINT);
    expect(res.status).toBe(403);
  });
});

describe("GET /dashboard-v2/buyer-status-banner — mode = clear", () => {
  it("returns clear with zeroed counts when nothing is pending", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client
      .get(ENDPOINT)
      .query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    expect(res.body?.status).toBe(1);
    const d = res.body?.data;
    expect(d).toBeDefined();
    expect(d.mode).toBe("clear");
    expect(d.counts.closing_soon).toBe(0);
    expect(d.counts.closed_no_quotes).toBe(0);
    expect(d.counts.quote_compare_ready).toBe(0);
    expect(d.counts.po_acceptance_pending).toBe(0);
    // pending_approvals can be > 0 if the seed has unrelated rows; only
    // assert it's a non-negative integer.
    expect(typeof d.counts.pending_approvals).toBe("number");
    expect(d.greeting).toBeDefined();
    expect(d.weekly).toBeDefined();
    expect(typeof d.weekly.rfqs_published).toBe("number");
  });
});

describe("GET /dashboard-v2/buyer-status-banner — mode escalates with state", () => {
  it("action_needed: an RFQ closes within 24h", async () => {
    // Published RFQ with bid_end_date 12h from now → closing_soon = 1.
    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1,
      bid_end_date: offsetString(12 * 3600_000),
      title: "Closes within 24h",
    });
    inserted.rfqIds.push(rfq_id);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client
      .get(ENDPOINT)
      .query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.counts.closing_soon).toBeGreaterThanOrEqual(1);
    expect(["action_needed", "critical"]).toContain(d.mode);
    // The soonest-closing payload should call out this RFQ.
    expect(d.soonest_closing).toBeTruthy();
    expect(d.soonest_closing.id).toBe(rfq_id);
  });

  it("critical: a published RFQ ended with zero real quotes (no regrets) within 14 days", async () => {
    // Item 2d: banner now requires status=1 (open) to match RFQ_STUCK_COMMERCIAL.
    // A closed (status=2) zero-quote RFQ no longer counts; use status=1 with
    // an expired bid window (the RFQ_STUCK_COMMERCIAL / "stuck" shape).
    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1, // open (status=2 excluded after Item 2d fix)
      bid_end_date: offsetString(-2 * 86400_000), // 2 days ago
      title: "Ended without quotes",
    });
    inserted.rfqIds.push(rfq_id);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client
      .get(ENDPOINT)
      .query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.counts.closed_no_quotes).toBeGreaterThanOrEqual(1);
    expect(d.mode).toBe("critical");
  });

  it("steady: a PO is awaiting vendor acceptance (po_acceptance_pending > 0, nothing critical)", async () => {
    // Seed: published RFQ + a product + a PO in acceptance_pending state.
    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1,
      bid_end_date: offsetString(7 * 86400_000), // safely future
      title: "Has acceptance-pending PO",
    });
    inserted.rfqIds.push(rfq_id);

    // Inline product insert — addProductToRfq picks a random variant but
    // we don't care about specifics here.
    const variantRow = await db.one(
      `SELECT id FROM tbl_product_variant ORDER BY id LIMIT 1`
    );
    const prodRow = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
       VALUES ($1, '', '0', '', '', $2, 1)
       RETURNING id`,
      [rfq_id, variantRow.id]
    );

    const { po_id } = await makePO(db, {
      rfq_id,
      rfq_product_id: prodRow.id,
      vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A,
      status: "acceptance_pending",
    });
    inserted.poIds.push(po_id);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client
      .get(ENDPOINT)
      .query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.counts.po_acceptance_pending).toBeGreaterThanOrEqual(1);
    // mode should escalate from clear at minimum. critical is also fine if
    // the test seed has lingering closed-no-quotes from other suites running
    // against the shared schema — both are acceptable signals of escalation.
    expect(["steady", "action_needed", "critical"]).toContain(d.mode);
  });

  it("includes a greeting with the user's first name", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client
      .get(ENDPOINT)
      .query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    expect(res.body.data.greeting).toBeDefined();
    // The fixture user name is non-empty; first_name should be a non-empty
    // string with no whitespace.
    expect(typeof res.body.data.greeting.first_name).toBe("string");
    expect(res.body.data.greeting.first_name.length).toBeGreaterThan(0);
    expect(res.body.data.greeting.first_name).not.toMatch(/\s/);
  });
});

describe("GET /dashboard-v2/buyer-status-banner — respects selected date range", () => {
  it("excludes a closed-no-quotes RFQ whose bid_end falls outside the range", async () => {
    // RFQ open without quotes, bid ended ~3 days ago (i.e. in 2026).
    // Item 2d: banner requires status=1; use status=1 so the wide-range assertion
    // still validates the date-window scoping logic (unchanged).
    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1,
      bid_end_date: offsetString(-3 * 86400_000),
      title: "Out-of-range closed-no-quotes",
    });
    inserted.rfqIds.push(rfq_id);

    const client = await httpClient(IDS.users.a1_proc_buyer);

    // A range entirely in the past (calendar year 2020) must NOT include the
    // RFQ that closed a few days ago.
    const past = await client.get(ENDPOINT).query({
      hotel_ids: String(IDS.hotels.A1),
      start_date: "2020-01-01",
      end_date: "2020-12-31",
    });
    expect(past.status).toBe(200);
    expect(past.body.data.counts.closed_no_quotes).toBe(0);

    // A wide range that includes today DOES count it.
    const wide = await client.get(ENDPOINT).query({
      hotel_ids: String(IDS.hotels.A1),
      start_date: "2020-01-01",
      end_date: "2999-01-01",
    });
    expect(wide.status).toBe(200);
    expect(wide.body.data.counts.closed_no_quotes).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IST bid-window boundary.
//
// `tbl_rfq.bid_end_date` is naive IST text. `NOW()` is a `timestamptz`, so
// `bid_end_date::timestamp <op> NOW()` makes Postgres promote the naive side
// through the SESSION timezone. Production's session timezone is UTC, so an
// 11:00 IST deadline was compared as the instant 11:00 UTC — 16:30 IST. Every
// boundary landed 5h30m late, all day, every day.
//
// The error is `5h30m − session_offset`: it does not merely shrink east of
// IST, it changes sign. So the seeds below straddle the boundary in both
// directions, and each is a straight true/false flip between the old model
// and the fixed one:
//
//   • closed 2 IST-hours ago — WEST of IST (production: UTC, +5h30m) the bid
//     reads as 3h30m in the FUTURE, so it lands in "closing soon" and never in
//     "closed, no quotes". Exactly backwards.
//   • closes in 1 IST-hour — EAST of IST (Asia/Singapore, −2h30m) the bid
//     reads as 1h30m in the PAST, so a live RFQ vendors can still quote on is
//     reported as closed-with-no-quotes and forces the banner into critical.
//   • closes in 23 IST-hours — UTC reads it as 28h30m out, past the 24h
//     window, so no warning fires on a bid closing tomorrow.
//
// Run them against a non-IST Postgres session to see the failures — the lever
// is PGOPTIONS, not TZ (TZ is a Node setting and never reaches the server).
// One timezone is not enough to catch all three; UTC exposes the first and
// third, Asia/Singapore the second:
//
//   PGOPTIONS="-c timezone=UTC" TEST_RUN_ID=... npm test -- \
//     --testPathPatterns "dashboard.statusBanner"
//
// Counts are asserted as deltas against a baseline read taken immediately
// before seeding, because every suite in a Jest process shares one database.
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /dashboard-v2/buyer-status-banner — IST bid-window boundary", () => {
  const QUERY = { hotel_ids: String(IDS.hotels.A1) };

  async function readCounts(client) {
    const res = await client.get(ENDPOINT).query(QUERY);
    expect(res.status).toBe(200);
    return res.body.data;
  }

  it("counts a bid that closed 2 IST-hours ago as closed_no_quotes, not closing_soon", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const before = await readCounts(client);

    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1,
      bid_end_date: offsetString(-2 * 3600_000), // 2 IST-hours in the past
      title: "Closed 2 IST-hours ago",
    });
    inserted.rfqIds.push(rfq_id);

    const after = await readCounts(client);

    // The bid IS over.
    expect(after.counts.closed_no_quotes).toBe(before.counts.closed_no_quotes + 1);
    // …and therefore is NOT "closing soon". Under the old model with a UTC
    // session this incremented instead, and named the RFQ as soonest-closing.
    expect(after.counts.closing_soon).toBe(before.counts.closing_soon);
    expect(after.soonest_closing?.id).not.toBe(rfq_id);
    // closed_no_quotes >= 1 forces critical mode.
    expect(after.mode).toBe("critical");
  });

  it("does NOT count a bid closing in 1 IST-hour as closed_no_quotes", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const before = await readCounts(client);

    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1,
      bid_end_date: offsetString(1 * 3600_000), // 1 IST-hour in the future
      title: "Closes in 1 IST-hour",
    });
    inserted.rfqIds.push(rfq_id);

    const after = await readCounts(client);

    // Still open — vendors can quote for another hour.
    expect(after.counts.closing_soon).toBe(before.counts.closing_soon + 1);
    expect(after.soonest_closing).toBeTruthy();
    // Under the old model on a session EAST of IST this incremented, marking a
    // live bid as dead and forcing the banner into critical mode.
    expect(after.counts.closed_no_quotes).toBe(before.counts.closed_no_quotes);
  });

  it("counts a bid closing in 23 IST-hours as closing_soon", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const before = await readCounts(client);

    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1,
      bid_end_date: offsetString(23 * 3600_000), // inside the 24h window
      title: "Closes in 23 IST-hours",
    });
    inserted.rfqIds.push(rfq_id);

    const after = await readCounts(client);

    // Under the old model with a UTC session this read as 28h30m away and the
    // count did not move — the buyer got no warning on a bid closing tomorrow.
    expect(after.counts.closing_soon).toBe(before.counts.closing_soon + 1);
    // A future bid window is not a closed one.
    expect(after.counts.closed_no_quotes).toBe(before.counts.closed_no_quotes);
  });

  it("keeps a bid that closed 6 IST-hours ago out of closing_soon (outside the 5h30m band)", async () => {
    // Control: 6h > 5h30m, so old and new agree here. Its job is to prove the
    // two tests above fail on the SKEW and not on some unrelated regression in
    // how the seed or the endpoint handles past bid windows.
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const before = await readCounts(client);

    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1,
      bid_end_date: offsetString(-6 * 3600_000),
      title: "Closed 6 IST-hours ago",
    });
    inserted.rfqIds.push(rfq_id);

    const after = await readCounts(client);
    expect(after.counts.closed_no_quotes).toBe(before.counts.closed_no_quotes + 1);
    expect(after.counts.closing_soon).toBe(before.counts.closing_soon);
  });
});

describe("GET /dashboard-v2/buyer-status-banner — scope", () => {
  it("excludes RFQs from a hotel the user has not selected", async () => {
    // RFQ on hotel A2 — the buyer has scope on A1+A2 in fixtures, but the
    // query filters to A1 only. So this RFQ must NOT contribute to the
    // closing-soon count.
    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A2,
      is_published: 1,
      status: 1,
      bid_end_date: offsetString(6 * 3600_000),
      title: "Out-of-scope closing-soon",
    });
    inserted.rfqIds.push(rfq_id);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client
      .get(ENDPOINT)
      .query({ hotel_ids: String(IDS.hotels.A1) });

    expect(res.status).toBe(200);
    const d = res.body.data;
    // The closing_soon count should NOT include this RFQ.
    expect(
      d.soonest_closing == null || d.soonest_closing.id !== rfq_id
    ).toBe(true);
  });
});

describe("GET /dashboard-v2/buyer-status-banner — Item 2d: closed_no_quotes requires status=1 (open)", () => {
  it("does NOT count a status=2 (closed) zero-quote RFQ in closed_no_quotes", async () => {
    // Before: capture baseline (other seeded rows may already exist).
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const before = await client
      .get(ENDPOINT)
      .query({ hotel_ids: String(IDS.hotels.A1), start_date: "2020-01-01", end_date: "2999-01-01" });
    expect(before.status).toBe(200);
    const baselineCount = before.body.data.counts.closed_no_quotes;

    // Seed a status=2 (closed), published RFQ with bid_end in the past and
    // no quotes — this is exactly the shape that used to count before the fix.
    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 2, // CLOSED — should now be excluded
      bid_end_date: offsetString(-1 * 86400_000), // 1 day ago
      title: "Closed (status=2) zero-quote — must not count",
    });
    inserted.rfqIds.push(rfq_id);

    const after = await client
      .get(ENDPOINT)
      .query({ hotel_ids: String(IDS.hotels.A1), start_date: "2020-01-01", end_date: "2999-01-01" });
    expect(after.status).toBe(200);
    // Count must NOT have increased — status=2 RFQs are excluded after Item 2d.
    expect(after.body.data.counts.closed_no_quotes).toBe(baselineCount);
  });

  it("DOES count a status=1 (open) zero-quote RFQ with expired bid window in closed_no_quotes", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const before = await client
      .get(ENDPOINT)
      .query({ hotel_ids: String(IDS.hotels.A1), start_date: "2020-01-01", end_date: "2999-01-01" });
    expect(before.status).toBe(200);
    const baselineCount = before.body.data.counts.closed_no_quotes;

    // Seed a status=1 (open), published RFQ with bid_end in the past, no quotes.
    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1, // OPEN — should still count (RFQ_STUCK_COMMERCIAL shape)
      bid_end_date: offsetString(-1 * 86400_000), // 1 day ago
      title: "Open (status=1) zero-quote expired bid — must count",
    });
    inserted.rfqIds.push(rfq_id);

    const after = await client
      .get(ENDPOINT)
      .query({ hotel_ids: String(IDS.hotels.A1), start_date: "2020-01-01", end_date: "2999-01-01" });
    expect(after.status).toBe(200);
    expect(after.body.data.counts.closed_no_quotes).toBeGreaterThanOrEqual(baselineCount + 1);
  });
});
