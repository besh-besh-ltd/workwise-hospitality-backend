// Integration tests for GET /api/v1/vendor-dashboard/status-banner.
//
// Mirrors the buyer-side banner test pattern. Vendor scope is implicit
// (req.user.id) so we just authenticate as a vendor fixture and assert
// the mode escalates as we seed the right state.

import { describe, it, expect, afterAll, beforeEach, afterEach } from "@jest/globals";
import moment from "moment-timezone";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  makePO,
  cleanupPurchaseOrders,
} from "../helpers/dashboardSeed.js";

afterAll(async () => {
  await closeDb();
});

const ENDPOINT = "/api/v1/vendor-dashboard/status-banner";

// Helper — `now + offsetMs` as a NAIVE IST wall-clock string, the exact shape
// `tbl_rfq.bid_end_date` (text) holds in production.
//
// This used to be `new Date(Date.now() + off).toISOString()`, which writes a
// UTC wall clock into a column the whole application reads as IST. That is a
// built-in 5h30m lie, and it leaned in EXACTLY the same direction as the model
// bug these tests now pin: on a UTC Postgres session the UTC-shifted seed and
// the UTC-misread predicate cancelled out, so the suite was green by accident
// rather than by correctness. Every offset below now means what it says.
// Precedent: tests/services/dashboard.statusBanner.test.js.
function offsetString(offsetMs) {
  return moment.tz("Asia/Kolkata").add(offsetMs, "ms").format("YYYY-MM-DD HH:mm:ss");
}

const inserted = { rfqIds: [], poIds: [] };

beforeEach(() => {
  inserted.rfqIds = [];
  inserted.poIds = [];
});

afterEach(async () => {
  await cleanupPurchaseOrders(db, inserted.poIds);
  if (inserted.rfqIds.length) {
    // Drop product-vendor invite rows + quotes we may have seeded.
    await db.none(
      `DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1)`,
      [inserted.rfqIds]
    );
    await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1)`, [inserted.rfqIds]);
  }
  await cleanupRfqs(db, inserted.rfqIds);
});

// Helper — seed an RFQ + invite a vendor to it.
async function seedInvitedRfq({ vendor_id, bid_end_date, viewed = false }) {
  const r = await makeRfqVisibleToDashboard(db, {
    createdBy: IDS.users.a1_proc_buyer,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    is_published: 1,
    status: 1,
    bid_end_date,
    title: `Invited RFQ for vendor ${vendor_id}`,
  });
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, is_rfq_viewed)
     VALUES ($1, 1, $2, $3)`,
    [r.rfq_id, vendor_id, viewed ? 1 : 0]
  );
  return r.rfq_id;
}

describe("GET /vendor-dashboard/status-banner — auth", () => {
  it("returns 401 without a JWT", async () => {
    const client = await httpClient(null);
    const res = await client.get(ENDPOINT);
    expect([401, 403]).toContain(res.status);
  });
});

describe("GET /vendor-dashboard/status-banner — mode = clear", () => {
  it("returns clear with zeroed counts when nothing is pending", async () => {
    const client = await httpClient(IDS.users.vendor_alpha);
    const res = await client.get(ENDPOINT);

    expect(res.status).toBe(200);
    expect(res.body?.status).toBe(1);
    const d = res.body?.data;
    expect(d).toBeDefined();
    // No invited / closing / negotiation / PO state seeded in this test.
    expect(d.counts.closing_soon).toBe(0);
    expect(d.counts.pending_negotiation).toBe(0);
    expect(d.counts.po_acceptance_pending).toBe(0);
    // Mode could be clear or steady depending on shared seed; both are
    // acceptable when none of the action-needed counts fired.
    expect(["clear", "steady"]).toContain(d.mode);
    expect(d.greeting).toBeDefined();
  });
});

describe("GET /vendor-dashboard/status-banner — mode escalates with state", () => {
  it("steady: vendor was invited to an RFQ they have not viewed (with bid still future)", async () => {
    const rfqId = await seedInvitedRfq({
      vendor_id: IDS.users.vendor_alpha,
      // Future enough that closing_soon doesn't fire (>24h).
      bid_end_date: offsetString(5 * 86400_000),
      viewed: false,
    });
    inserted.rfqIds.push(rfqId);

    const client = await httpClient(IDS.users.vendor_alpha);
    const res = await client.get(ENDPOINT);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.counts.new_rfqs_unviewed).toBeGreaterThanOrEqual(1);
    // Could be steady or escalated if subscription is also expiring; both valid.
    expect(["steady", "action_needed", "critical"]).toContain(d.mode);
  });

  it("action_needed: an invited RFQ closes within 24h and vendor hasn't quoted", async () => {
    const rfqId = await seedInvitedRfq({
      vendor_id: IDS.users.vendor_alpha,
      bid_end_date: offsetString(12 * 3600_000),
      viewed: true, // simulate they viewed but didn't quote
    });
    inserted.rfqIds.push(rfqId);

    const client = await httpClient(IDS.users.vendor_alpha);
    const res = await client.get(ENDPOINT);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.counts.closing_soon).toBeGreaterThanOrEqual(1);
    expect(["action_needed", "critical"]).toContain(d.mode);
    expect(d.soonest_closing).toBeTruthy();
    expect(d.soonest_closing.id).toBe(rfqId);
  });

  it("win: a lone acceptance_pending PO is a positive win (Sr 335), not action_needed", async () => {
    // Seed published RFQ + product + PO awaiting acceptance by vendor_alpha.
    const r = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1,
      bid_end_date: offsetString(7 * 86400_000),
      title: "PO awaiting vendor accept",
    });
    inserted.rfqIds.push(r.rfq_id);

    const variantRow = await db.one(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 1`);
    const prodRow = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
       VALUES ($1, '', '0', '', '', $2, 1)
       RETURNING id`,
      [r.rfq_id, variantRow.id]
    );
    const { po_id } = await makePO(db, {
      rfq_id: r.rfq_id,
      rfq_product_id: prodRow.id,
      vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A,
      status: "acceptance_pending",
    });
    inserted.poIds.push(po_id);

    const client = await httpClient(IDS.users.vendor_alpha);
    const res = await client.get(ENDPOINT);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.counts.po_acceptance_pending).toBeGreaterThanOrEqual(1);
    // Sr 335: an awaiting-acceptance PO is a positive WIN (the vendor was awarded
    // an order), not an amber warning. It escalates to action_needed only under
    // time pressure (closing bid / open negotiation / expiring subscription),
    // none of which are seeded here.
    expect(d.mode).toBe("win");
  });

  it("includes a greeting with the user's first name", async () => {
    const client = await httpClient(IDS.users.vendor_alpha);
    const res = await client.get(ENDPOINT);
    expect(res.status).toBe(200);
    expect(res.body.data.greeting).toBeDefined();
    expect(typeof res.body.data.greeting.first_name).toBe("string");
    expect(res.body.data.greeting.first_name.length).toBeGreaterThan(0);
    expect(res.body.data.greeting.first_name).not.toMatch(/\s/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IST bid-window boundary — the TIMESTAMP family.
//
// `tbl_rfq.bid_end_date` is naive IST text. `NOW()` is a `timestamptz`, so
// `bid_end_date::timestamp <op> NOW()` makes Postgres promote the naive side
// through the SESSION timezone. Production's session timezone is UTC, so an
// 11:00 IST deadline was compared as the instant 11:00 UTC — 16:30 IST. Every
// boundary landed 5h30m late, all day, every day.
//
// On this endpoint that hit two counts, both fed by `vendorDashboardModel`:
//   • new_rfqs_unviewed — gated on `bid_end_date::timestamp > NOW()`, i.e.
//     "the bid window is still open". The most consequential site in the file:
//     it decides which RFQs a vendor is told they can still quote on, so under
//     production's UTC session the list included RFQs that had actually closed
//     up to 5h30m earlier.
//   • closing_soon — `bid_end_date::timestamp BETWEEN NOW() AND NOW() + 24h`,
//     which under UTC really covered 5h30m in the PAST to 18h30m ahead.
//
// The error is `5h30m − session_offset`: it does not merely shrink east of
// IST, it CHANGES SIGN. So the seeds below straddle the boundary in both
// directions, and each is a straight true/false flip between the old model and
// the fixed one:
//
//   • closed 2 IST-hours ago — WEST of IST (production: UTC, +5h30m) the bid
//     reads as 3h30m in the FUTURE, so a dead RFQ is both "still open" and
//     "closing soon". Exactly backwards.
//   • closes in 1 IST-hour — EAST of IST (Asia/Singapore, −2h30m) the bid
//     reads as 1h30m in the PAST, so a live RFQ the vendor can still win
//     disappears from both counts.
//   • closes in 23 IST-hours — UTC reads it as 28h30m out, past the 24h
//     window, so no warning fires on a bid closing tomorrow.
//
// Run against a non-IST Postgres session to see the failures — the lever is
// PGOPTIONS, not TZ (TZ is a Node setting and never reaches the server). One
// timezone is not enough: UTC exposes the first and third, Asia/Singapore the
// second.
//
//   PGOPTIONS="-c timezone=UTC" TEST_RUN_ID=... npm test -- \
//     --testPathPatterns "vendor.statusBanner"
//
// Counts are asserted as deltas against a baseline read taken immediately
// before seeding, because every suite in a Jest process shares one database.
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /vendor-dashboard/status-banner — IST bid-window boundary", () => {
  async function readBanner(client) {
    const res = await client.get(ENDPOINT);
    expect(res.status).toBe(200);
    return res.body.data;
  }

  it("drops an RFQ whose bid closed 2 IST-hours ago from both new_rfqs_unviewed and closing_soon", async () => {
    const client = await httpClient(IDS.users.vendor_alpha);
    const before = await readBanner(client);

    const rfqId = await seedInvitedRfq({
      vendor_id: IDS.users.vendor_alpha,
      bid_end_date: offsetString(-2 * 3600_000), // 2 IST-hours in the past
      viewed: false,
    });
    inserted.rfqIds.push(rfqId);

    const after = await readBanner(client);

    // The bid window IS over — the vendor can no longer quote, so neither the
    // "go look at this" count nor the "hurry up" count may move. Under the old
    // model on a UTC session BOTH incremented.
    expect(after.counts.new_rfqs_unviewed).toBe(before.counts.new_rfqs_unviewed);
    expect(after.counts.closing_soon).toBe(before.counts.closing_soon);
    expect(after.soonest_closing?.id).not.toBe(rfqId);
  });

  it("keeps an RFQ closing in 1 IST-hour in both new_rfqs_unviewed and closing_soon", async () => {
    const client = await httpClient(IDS.users.vendor_alpha);
    const before = await readBanner(client);

    const rfqId = await seedInvitedRfq({
      vendor_id: IDS.users.vendor_alpha,
      bid_end_date: offsetString(1 * 3600_000), // 1 IST-hour in the future
      viewed: false,
    });
    inserted.rfqIds.push(rfqId);

    const after = await readBanner(client);

    // Still open — the vendor has an hour left to win this. Under the old model
    // on a session EAST of IST both counts stayed flat and the RFQ silently
    // vanished from the banner while it was still live.
    expect(after.counts.new_rfqs_unviewed).toBe(before.counts.new_rfqs_unviewed + 1);
    expect(after.counts.closing_soon).toBe(before.counts.closing_soon + 1);
    expect(after.soonest_closing).toBeTruthy();
    // Only pin the named RFQ when nothing else was already closing sooner —
    // the DB is shared across suites in a Jest process.
    if (before.soonest_closing == null) {
      expect(after.soonest_closing.id).toBe(rfqId);
    }
  });

  it("counts an RFQ closing in 23 IST-hours as closing_soon", async () => {
    const client = await httpClient(IDS.users.vendor_alpha);
    const before = await readBanner(client);

    const rfqId = await seedInvitedRfq({
      vendor_id: IDS.users.vendor_alpha,
      bid_end_date: offsetString(23 * 3600_000), // inside the 24h window
      viewed: false,
    });
    inserted.rfqIds.push(rfqId);

    const after = await readBanner(client);

    // Under the old model on a UTC session this read as 28h30m away and the
    // count did not move — no warning on a bid closing tomorrow.
    expect(after.counts.closing_soon).toBe(before.counts.closing_soon + 1);
    expect(after.counts.new_rfqs_unviewed).toBe(before.counts.new_rfqs_unviewed + 1);
  });

  it("keeps an RFQ that closed 8 IST-hours ago out of both counts (outside every skew band)", async () => {
    // Control: 8h is further out than both |5h30m| (UTC) and |2h30m|
    // (Asia/Singapore), so under those two sessions the old and new models
    // agree here. Its job is to prove the three tests above fail on the SKEW
    // and not on some unrelated regression in how the seed or the endpoint
    // handles past bid windows. (Under a deliberately extreme session such as
    // Etc/GMT+12 the skew is 17h30m and even this one goes red on the old
    // model — that is the control doing its job, not a broken assertion.)
    const client = await httpClient(IDS.users.vendor_alpha);
    const before = await readBanner(client);

    const rfqId = await seedInvitedRfq({
      vendor_id: IDS.users.vendor_alpha,
      bid_end_date: offsetString(-8 * 3600_000),
      viewed: false,
    });
    inserted.rfqIds.push(rfqId);

    const after = await readBanner(client);
    expect(after.counts.new_rfqs_unviewed).toBe(before.counts.new_rfqs_unviewed);
    expect(after.counts.closing_soon).toBe(before.counts.closing_soon);
  });
});

describe("GET /vendor-dashboard/status-banner — scope", () => {
  it("does not expose another vendor's invited RFQ to this vendor", async () => {
    // RFQ where vendor_beta is invited; vendor_alpha must NOT see it.
    const rfqId = await seedInvitedRfq({
      vendor_id: IDS.users.vendor_beta,
      bid_end_date: offsetString(6 * 3600_000),
      viewed: true,
    });
    inserted.rfqIds.push(rfqId);

    const client = await httpClient(IDS.users.vendor_alpha);
    const res = await client.get(ENDPOINT);
    expect(res.status).toBe(200);
    const d = res.body.data;
    // The closing_soon count for vendor_alpha must NOT include vendor_beta's RFQ.
    expect(
      d.soonest_closing == null || d.soonest_closing.id !== rfqId
    ).toBe(true);
  });
});
