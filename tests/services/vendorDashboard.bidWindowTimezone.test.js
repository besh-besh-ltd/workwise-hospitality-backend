// IST bid-window boundary on the vendor dashboard — opportunity feed + insights.
//
// Companion to tests/services/vendor.statusBanner.test.js, which pins the same
// boundary on the status-banner counts. This file pins the three counts fed by
// app/models/vendorDashboardModel.js's other two entry points:
//
//   GET /vendor-dashboard/opportunities → pending_quotes
//   GET /vendor-dashboard/opportunities → closing_soon   (3-day window)
//   GET /vendor-dashboard/insights      → response_efficiency.missed_count
//
// WHAT THESE THREE MEAN NOW — read this before changing an assertion
// They used to compare `DATE(bid_end_date)` against the IST calendar day, i.e.
// they were DAY-granular: an RFQ whose bid closed at 09:00 IST stayed on the
// opportunity feed, and stayed out of the missed count, until IST midnight. The
// vendor was invited to go quote on a bid they had already lost, for up to 15
// hours. All three now compare at IST wall-clock precision — the deadline's
// actual TIME decides — which is how the status banner in this same file, the
// buyer dashboard, and `bid_ended` in rfqModel.js already behaved.
//
// The one that changed SHAPE rather than just precision is closing_soon. Its
// 3-day window used to mean "the bid's closing CALENDAR DAY falls between today
// and today+3": a four-day span reaching up to ~96h ahead, and — because today
// is its lower bound — reaching BACKWARDS over every bid that had already
// closed earlier today. It now means a ROLLING 72 HOURS FROM THIS INSTANT, with
// already-closed bids excluded. Two consequences the tests below pin directly:
//   • a bid closing 73h out is NOT closing soon, even though its calendar day
//     is day+3 and the old window covered it;
//   • a bid that closed this morning is NOT closing soon (nor pending), where
//     the old window advertised it as urgent for the rest of the day.
//
// WHY IT IS WRONG WITHOUT AN EXPLICIT IST CLOCK
// `tbl_rfq.bid_end_date` is `text` holding a NAIVE IST wall-clock string with no
// offset. `NOW()` is a `timestamptz`, so `bid_end_date::timestamp <op> NOW()`
// makes Postgres promote the naive side through the SESSION timezone.
// Production's session timezone is UTC, so an 11:00 IST deadline would be
// compared as the instant 11:00 UTC — 16:30 IST, every boundary 5h30m late.
// The model therefore compares against `(CURRENT_TIMESTAMP AT TIME ZONE
// 'Asia/Kolkata')`, which is naive-IST on both sides and so carries no session
// dependence at all. Every assertion below is written in IST terms and must
// hold under every session timezone.
//
// HOW TO SEE IT GO RED
// The lever is PGOPTIONS, not TZ — TZ is a Node process setting and never
// reaches the Postgres server:
//
//   PGOPTIONS="-c timezone=UTC" TEST_RUN_ID=... npm test -- \
//     --testPathPatterns "vendorDashboard.bidWindowTimezone"
//
// One timezone is not enough. The error is `5h30m − session_offset`, so it does
// not merely shrink east of IST, it CHANGES SIGN: on Asia/Singapore (+8) it is
// 2h30m EARLY where on UTC it is 5h30m LATE. A seed placed to catch one
// direction passes against the broken code under the other. The seeds below
// straddle the boundary both ways, so between `UTC` and `Asia/Singapore` no
// session can hide a failure. `Etc/GMT+12` (UTC−12) is the same lever amplified
// — a 17h30m skew — useful when a seed's margin is too small to discriminate
// under UTC alone.
//
// Counts are asserted as deltas against a baseline read taken immediately
// before seeding, because every suite in a Jest process shares one database.

import { describe, it, expect, afterAll, beforeEach, afterEach } from "@jest/globals";
import moment from "moment-timezone";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { makeRfqVisibleToDashboard, cleanupRfqs } from "../helpers/dashboardSeed.js";

afterAll(async () => {
  await closeDb();
});

const IST = "Asia/Kolkata";
const OPPORTUNITIES = "/api/v1/vendor-dashboard/opportunities";
const INSIGHTS = "/api/v1/vendor-dashboard/insights";
const VENDOR = IDS.users.vendor_alpha;

// A range wide enough to contain the seeded RFQs' `r.timestamp` (which is a
// real timestamp column written by `now()`), narrow enough that the insights
// endpoint's month-by-month generate_series stays small.
const RANGE = {
  start_date: moment.tz(IST).subtract(1, "year").format("YYYY-MM-DD"),
  end_date: moment.tz(IST).add(1, "year").format("YYYY-MM-DD"),
};

/**
 * A naive IST wall-clock string `hours` from now. This is the exact shape
 * `bid_end_date` holds in production — no offset, no `Z`, IST wall clock.
 */
function istHoursFromNow(hours) {
  return moment.tz(IST).add(hours, "hours").format("YYYY-MM-DD HH:mm:ss");
}

/** Same, on the IST calendar day `dayOffset` days from today, at `time`. */
function istDay(dayOffset, time) {
  return `${moment.tz(IST).add(dayOffset, "days").format("YYYY-MM-DD")} ${time}`;
}

/**
 * A moment that is in the PAST but still on the CURRENT IST calendar day —
 * the seed the whole granularity question turns on. Day-granular predicates
 * call it "today, so still open"; moment-granular ones call it "closed".
 *
 * Normally 2 IST-hours ago. Between 00:00 and 02:00 IST that would fall onto
 * yesterday and stop testing anything, so it clamps to the start of the IST
 * day, shrinking the margin rather than crossing the boundary. The clamped
 * value stays strictly in the past: `startOf('day')` is 00:00:00.000 while
 * `now` carries milliseconds, and Postgres reads its own clock strictly after
 * this line runs, off the same system clock.
 */
function closedEarlierTodayIst() {
  const now = moment.tz(IST);
  const startOfDay = now.clone().startOf("day");
  const twoHoursAgo = now.clone().subtract(2, "hours");
  const t = twoHoursAgo.isAfter(startOfDay) ? twoHoursAgo : startOfDay;
  return t.format("YYYY-MM-DD HH:mm:ss");
}

const inserted = { rfqIds: [] };

beforeEach(() => {
  inserted.rfqIds = [];
});

afterEach(async () => {
  await cleanupRfqs(db, inserted.rfqIds);
});

/** Seed a published, open RFQ and invite `VENDOR` to it (no quote submitted). */
async function seedInvitedRfq(bid_end_date, title) {
  const { rfq_id } = await makeRfqVisibleToDashboard(db, {
    createdBy: IDS.users.a1_proc_buyer,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    is_published: 1,
    status: 1,
    bid_end_date,
    title,
  });
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, is_rfq_viewed)
     VALUES ($1, 1, $2, 0)`,
    [rfq_id, VENDOR]
  );
  inserted.rfqIds.push(rfq_id);
  return rfq_id;
}

/** Read the three bid-window-derived counts in one shot. */
async function readCounts(client) {
  const opp = await client.get(OPPORTUNITIES).query(RANGE);
  expect(opp.status).toBe(200);
  const ins = await client.get(INSIGHTS).query(RANGE);
  expect(ins.status).toBe(200);
  return {
    pending_quotes: opp.body.data.pending_quotes,
    closing_soon: opp.body.data.closing_soon,
    missed_count: ins.body.data.response_efficiency.missed_count,
  };
}

describe("vendor dashboard — bid window is moment-granular, not day-granular", () => {
  it("treats an RFQ whose bid closed EARLIER TODAY in IST as missed, not pending", async () => {
    // THE granularity test. Nothing else in this file discriminates day from
    // moment: the seed is in the past, but on the same IST calendar day, so a
    // `DATE(bid_end_date) >= CURRENT_DATE`-shaped predicate still calls it open.
    // Against the day-granular model this assertion is exactly inverted — it
    // counted +1 pending, +1 closing soon and +0 missed.
    const client = await httpClient(VENDOR);
    const before = await readCounts(client);

    await seedInvitedRfq(closedEarlierTodayIst(), "Bid closed earlier today IST");

    const after = await readCounts(client);

    // The deadline has passed. The vendor cannot quote, so the opportunity feed
    // must not offer it and the urgency count must not shout about it…
    expect(after.pending_quotes).toBe(before.pending_quotes);
    expect(after.closing_soon).toBe(before.closing_soon);
    // …and their response-efficiency card must own it as a miss today, not
    // tomorrow.
    expect(after.missed_count).toBe(before.missed_count + 1);
  });

  it("keeps an RFQ closing in 1 IST-hour pending and closing soon", async () => {
    // Mirror of the above on the future side, and the east-of-IST clock probe:
    // on an Asia/Singapore session a model using NOW() reads this deadline
    // 2h30m early, i.e. 1h30m in the PAST, and drops a live winnable bid from
    // both counts.
    const client = await httpClient(VENDOR);
    const before = await readCounts(client);

    await seedInvitedRfq(istHoursFromNow(1), "Bid closes in 1 IST-hour");

    const after = await readCounts(client);

    expect(after.pending_quotes).toBe(before.pending_quotes + 1);
    expect(after.closing_soon).toBe(before.closing_soon + 1);
    expect(after.missed_count).toBe(before.missed_count);
  });

  it("treats an RFQ whose bid window ended late on the PREVIOUS IST day as missed, not pending", async () => {
    // IST day-boundary coverage, past side. A session whose calendar day lags
    // IST — production's UTC between 18:30 and 24:00 UTC, or Etc/GMT+12 at any
    // hour — still calls this "today" and reports a dead RFQ as live.
    const client = await httpClient(VENDOR);
    const before = await readCounts(client);

    await seedInvitedRfq(istDay(-1, "23:50:00"), "Bid ended late yesterday IST");

    const after = await readCounts(client);

    expect(after.pending_quotes).toBe(before.pending_quotes);
    expect(after.closing_soon).toBe(before.closing_soon);
    expect(after.missed_count).toBe(before.missed_count + 1);
  });

  it("treats an RFQ closing just after IST midnight tonight as pending and closing soon", async () => {
    // IST day-boundary coverage, future side. Deliberately expressed as the
    // first minutes of the NEXT IST day rather than "late tonight": a seed at
    // 23:50 today is legitimately CLOSED once the clock passes 23:50, so under
    // moment granularity it would make this suite fail for ten minutes a day.
    const client = await httpClient(VENDOR);
    const before = await readCounts(client);

    await seedInvitedRfq(istDay(1, "00:05:00"), "Bid closes just after IST midnight");

    const after = await readCounts(client);

    // Between 6 minutes and 24 hours away depending on when this runs — always
    // future, always inside the 72h window.
    expect(after.pending_quotes).toBe(before.pending_quotes + 1);
    expect(after.closing_soon).toBe(before.closing_soon + 1);
    expect(after.missed_count).toBe(before.missed_count);
  });

  it("includes a bid closing in 71 IST-hours in the 3-day closing-soon window", async () => {
    // Inner edge of the rolling 72h window. On a UTC session a model using
    // NOW() reads this as 76h30m out and drops it.
    const client = await httpClient(VENDOR);
    const before = await readCounts(client);

    await seedInvitedRfq(istHoursFromNow(71), "Bid closes in 71 IST-hours");

    const after = await readCounts(client);

    expect(after.closing_soon).toBe(before.closing_soon + 1);
    expect(after.pending_quotes).toBe(before.pending_quotes + 1);
    expect(after.missed_count).toBe(before.missed_count);
  });

  it("excludes a bid closing in 73 IST-hours from the 3-day closing-soon window", async () => {
    // Outer edge, and the assertion that pins the window's new SHAPE. 73h out
    // lands on IST calendar day +3 for all but the last hour of the day, which
    // the old `BETWEEN CURRENT_DATE AND CURRENT_DATE + 3 days` window covered —
    // so this is red against the day-granular model too, not only against a
    // wrong-clock one. Rolling 72h means 72h.
    const client = await httpClient(VENDOR);
    const before = await readCounts(client);

    await seedInvitedRfq(istHoursFromNow(73), "Bid closes in 73 IST-hours");

    const after = await readCounts(client);

    expect(after.closing_soon).toBe(before.closing_soon);
    // Still a live opportunity, just not an urgent one.
    expect(after.pending_quotes).toBe(before.pending_quotes + 1);
    expect(after.missed_count).toBe(before.missed_count);
  });

  it("counts an RFQ with an EMPTY bid_end_date as pending, and does not break the query", async () => {
    // `bid_end_date` is text NOT NULL and a real share of rows hold ''. An
    // unguarded `''::timestamp` does not yield NULL — it raises `invalid input
    // syntax for type timestamp: ""` and aborts the WHOLE query, so a single
    // such row 500s both endpoints for every vendor.
    //
    // Honest scope note: the `expect(status).toBe(200)` inside readCounts is
    // this test's real assertion, but it does NOT by itself prove the model's
    // NULLIF is load-bearing — strip the NULLIF and this test still passes,
    // because on today's plans Postgres happens to evaluate the `= ''` / `!= ''`
    // conjunct first. That short-circuit is a property of the plan, not of the
    // SQL: move the same guard onto a joined relation and it raises. So this
    // test pins the OBSERVABLE contract (an RFQ with no deadline is a live
    // opportunity and does not break the page); NULLIF is what keeps that
    // contract from depending on the planner. Do not delete it because this
    // test is green without it.
    const client = await httpClient(VENDOR);
    const before = await readCounts(client);

    await seedInvitedRfq("", "Bid with no deadline at all");

    const after = await readCounts(client);

    // No deadline means the window has not closed — pre-change behaviour,
    // preserved deliberately.
    expect(after.pending_quotes).toBe(before.pending_quotes + 1);
    // But "closes within 3 days" and "the vendor let it lapse" are both
    // meaningless without a deadline.
    expect(after.closing_soon).toBe(before.closing_soon);
    expect(after.missed_count).toBe(before.missed_count);
  });

  it("keeps an RFQ closing 10 IST days out pending but NOT closing soon", async () => {
    // Control. 10 days is far outside any calendar skew or clock offset, so
    // every variant of the model agrees. Its job is to prove the tests above
    // fail on the BOUNDARY and not on some unrelated regression in the
    // opportunity feed.
    const client = await httpClient(VENDOR);
    const before = await readCounts(client);

    await seedInvitedRfq(istDay(10, "09:00:00"), "Bid ends on IST day +10");

    const after = await readCounts(client);
    expect(after.pending_quotes).toBe(before.pending_quotes + 1);
    expect(after.closing_soon).toBe(before.closing_soon);
    expect(after.missed_count).toBe(before.missed_count);
  });

  it("keeps an RFQ that closed 10 IST days ago missed and NOT pending", async () => {
    // Control, mirrored to the past.
    const client = await httpClient(VENDOR);
    const before = await readCounts(client);

    await seedInvitedRfq(istDay(-10, "09:00:00"), "Bid ended on IST day −10");

    const after = await readCounts(client);
    expect(after.pending_quotes).toBe(before.pending_quotes);
    expect(after.closing_soon).toBe(before.closing_soon);
    expect(after.missed_count).toBe(before.missed_count + 1);
  });
});
