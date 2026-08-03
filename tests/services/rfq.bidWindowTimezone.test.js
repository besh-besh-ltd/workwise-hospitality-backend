// Bid-window predicates must be anchored to IST, not to the Postgres session
// timezone.
// ---------------------------------------------------------------------------
// `tbl_rfq.bid_end_date` is `text NOT NULL` holding a NAIVE IST wall-clock
// string ('2026-03-14T11:00'). It carries no offset, so a comparison against
// `CURRENT_DATE` resolves through the SESSION timezone, and a bare `date`
// compared against `now()` (timestamptz) is promoted to midnight IN THE SESSION
// ZONE. Production Postgres runs with TimeZone = UTC and the app never issues
// SET TIME ZONE, so both families were wrong there.
//
// EVERY bid-window predicate in app/models/rfqModel.js is now MOMENT-granular
// and anchored to IST, and this suite pins that for both surfaces:
//
//   1. VENDOR LISTING — facets `rfq_status` (open/closed) and `bid_ends_in`
//      (3d/5d/1w/1m), their COUNT twin in getVendorRfqCount, and the
//      "closing soon" stat in getVendorRfqStats.  => tests §1.x
//
//   2. BUYER DASHBOARD — `active_rfqs` / `quotes_received` / the RFQ chart's
//      `closed_rfqs` series.  => tests §2.x
//
// §1 previously pinned CALENDAR-DAY behaviour for the listing facets. That was
// deliberate at the time and is no longer the product's answer: an RFQ that
// stopped accepting bids at 09:00 IST kept advertising itself as "open" and
// "closing soon" until IST midnight — up to 15 hours after vendors could act on
// it — and disagreed with the buyer dashboard looking at the same RFQ. The two
// surfaces are now the same predicate. The visible consequences §1 pins:
//
//   - `open` / `closed` flip at the deadline MOMENT, not at IST midnight.
//   - `bid_ends_in = '3d'` is a ROLLING 72 HOURS from now, not "closes on a
//     calendar day within the next 3 days". Likewise 5d / 1w / 1m.
//   - a `bid_ends_in` facet can no longer contain an already-closed RFQ.
//
// REPRODUCING THE TIMEZONE BUG. `TZ=UTC` does NOT reproduce it — TZ is a Node
// setting and is never propagated to the Postgres session. The lever is
// PGOPTIONS, which node-postgres reads at connect time:
//
//   PGOPTIONS="-c timezone=Asia/Singapore" TEST_RUN_ID=x npm test -- --ci \
//     --testPathPatterns "tests/services/rfq\.bidWindowTimezone"
//
// DISCRIMINATING POWER, honestly stated:
//   - §2.x fail on the pre-fix code at essentially any hour and under ANY
//     session timezone (including Asia/Kolkata) — the truncation defect does
//     not depend on the clock.
//   - §1.x are now built from fixtures placed MINUTES either side of a boundary
//     (`istWall('-1 minute')`, `istWall('3 days 1 minute')`, …), read from the
//     database's own IST clock. Because the timezone error is 5h30m minus the
//     session offset — orders of magnitude larger than those margins — §1.x
//     fail against a session-zone-dependent predicate under any non-IST session
//     at any hour, in both directions (a zone west of IST such as UTC misfiles
//     one side, a zone east such as Asia/Singapore misfiles the other). That is
//     strictly stronger than the calendar-day fixtures they replace, which only
//     discriminated while the session's date differed from IST's.
//   - The one thing §1.x cannot detect is a reversion to day granularity in the
//     ~1-minute band on either side of IST midnight, where "earlier today" and
//     "yesterday" coincide. The assertions stay CORRECT there, they just stop
//     being informative; there is no fixture that avoids this, because the two
//     granularities genuinely agree at that instant.
//
// Everything here is asserted over real HTTP against real Postgres.
// Pattern B (commit + cleanup): the endpoints query db directly, so every
// inserted id is tracked and deleted in afterAll.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";

const BUYER = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;
const VARIANT_ID = 1;

// Every id this suite commits, torn down in afterAll.
const inserted = { rfqIds: [], quoteIds: [] };

let vendorClient;
let buyerClient;
let istToday; // 'YYYY-MM-DD' — today's calendar day in Asia/Kolkata

/** IST calendar day, offset by `days`, as 'YYYY-MM-DD'. */
function istDay(days) {
  const [y, m, d] = istToday.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * A naive IST wall-clock string at `now + interval`, in exactly the format
 * `tbl_rfq.bid_end_date` stores ('YYYY-MM-DDTHH:MI:SS').
 *
 * Read from the DATABASE clock, not the Node process clock: the predicate under
 * test evaluates `CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'` server-side, so
 * deriving the fixture the same way makes the two agree by construction rather
 * than by the test process's TZ (which never reaches Postgres) or by the two
 * clocks happening to be in sync.
 *
 * `interval` is any Postgres interval literal: '-1 minute', '3 days 1 minute'.
 */
async function istWall(interval) {
  const { s } = await db.one(
    `SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') + $1::interval,
                    'YYYY-MM-DD"T"HH24:MI:SS') AS s`,
    [interval]
  );
  return s;
}

/**
 * Seed a published, open-status RFQ closing at `bidEnd` (a naive IST
 * wall-clock string) and map VENDOR onto it so it reaches the vendor listing.
 */
async function seedRfq(bidEnd, { createdBy = BUYER, mapVendor = true } = {}) {
  const { rfq_id } = await makeRFQ(db, {
    createdBy,
    status: 1,
    is_published: 1,
    is_tender: 0,
    bid_end_date: bidEnd,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
  });
  const id = Number(rfq_id);
  inserted.rfqIds.push(id);

  await db.none(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0)`,
    [id, VARIANT_ID]
  );
  if (mapVendor) {
    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
       VALUES ($1, $2, $3, 0)`,
      [id, VARIANT_ID, VENDOR]
    );
  }
  return id;
}

async function seedQuote(rfqId) {
  const { rfq_no } = await db.one(`SELECT rfq_no FROM tbl_rfq WHERE id = $1`, [rfqId]);
  const row = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status)
     VALUES ($1, $2, $3, $3, 1) RETURNING id`,
    [rfqId, rfq_no, VENDOR]
  );
  inserted.quoteIds.push(Number(row.id));
  return Number(row.id);
}

/** POST the vendor listing with a filter set; returns { ids, total, stats }. */
async function vendorList(body) {
  const res = await vendorClient.post("/api/v1/rfq/getMyRfq").send({ limit: 1000, ...body });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe(1);
  return {
    ids: res.body.data.map((r) => Number(r.id)),
    total: Number(res.body.totalRFQ.count),
    stats: res.body.stats,
  };
}

/** Sum of the `closed_rfqs` series on GET /rfq/rfq-chart-data. */
async function buyerChartClosedTotal() {
  const res = await buyerClient.get("/api/v1/rfq/rfq-chart-data?chart_filter=past7days");
  expect(res.status).toBe(200);
  expect(res.body.status).toBe(1);
  return res.body.data.reduce((n, row) => n + Number(row.closed_rfqs || 0), 0);
}

async function buyerDashboard() {
  const res = await buyerClient
    .post("/api/v1/users/get-dashboard-data")
    .send({ page: 1, sort: "DESC" });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe(1);
  return res.body.data;
}

beforeAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [BUYER]);
  await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);
  vendorClient = await httpClient(VENDOR);
  buyerClient = await httpClient(BUYER);

  // The IST calendar day, read from the database itself so the fixture and the
  // production predicate agree by construction rather than by the test
  // process's TZ (which is irrelevant to the SQL).
  istToday = (
    await db.one(
      `SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date::text AS d`
    )
  ).d;
});

afterAll(async () => {
  if (inserted.quoteIds.length) {
    await db.none(`DELETE FROM tbl_quotes WHERE id = ANY($1::int[])`, [inserted.quoteIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
  await closeDb();
});

// ───────────────────────────────────────────────────────────────────────────
// §1 vendor listing facets, their COUNT twin, and the stats card
// ───────────────────────────────────────────────────────────────────────────
describe("§1 vendor listing bid-window facets compare the full IST timestamp", () => {
  let rJustClosed,
    rEndedYesterday,
    rClosingIn1h,
    rEndsIn2d,
    rInside3d,
    rJustOutside3d,
    rEndsIn4d,
    rJustOutside5d;

  beforeAll(async () => {
    // Fixtures sit MINUTES either side of each boundary, derived from the
    // database's IST clock. Two properties follow:
    //   - granularity: `rJustClosed` closed a minute ago but is still on the
    //     current IST calendar day, so day-granular code would call it "open";
    //     `rJustOutside3d` is 72h+1min out but lands on the same calendar day
    //     as today+3, so day-granular code would include it in the 3d facet.
    //   - timezone: the error is 5h30m minus the session offset, so a
    //     session-zone-dependent predicate misplaces every one of these by
    //     hours, in whichever direction the session zone lies from IST.
    rJustClosed     = await seedRfq(await istWall("-1 minute"));
    rEndedYesterday = await seedRfq(`${istDay(-1)}T23:45`);
    rClosingIn1h    = await seedRfq(await istWall("1 hour"));
    rEndsIn2d       = await seedRfq(await istWall("2 days"));
    rInside3d       = await seedRfq(await istWall("3 days -1 minute"));
    rJustOutside3d  = await seedRfq(await istWall("3 days 1 minute"));
    rEndsIn4d       = await seedRfq(await istWall("4 days"));
    rJustOutside5d  = await seedRfq(await istWall("5 days 1 minute"));
  });

  it("§1.1 an RFQ whose IST deadline is still ahead is OPEN", async () => {
    const { ids } = await vendorList({ rfq_status: "open" });
    expect(ids).toContain(rClosingIn1h);
    expect(ids).toContain(rEndsIn2d);
  });

  it("§1.2 an RFQ whose IST deadline has passed is not OPEN — including one that closed EARLIER TODAY", async () => {
    // The headline behaviour change. Day-granular code kept the just-closed RFQ
    // in "open" until IST midnight, so vendors saw bids they could no longer
    // place.
    const { ids } = await vendorList({ rfq_status: "open" });
    expect(ids).not.toContain(rJustClosed);
    expect(ids).not.toContain(rEndedYesterday);
  });

  it("§1.3 an RFQ whose IST deadline has passed is CLOSED", async () => {
    const { ids } = await vendorList({ rfq_status: "closed" });
    expect(ids).toContain(rJustClosed);
    expect(ids).toContain(rEndedYesterday);
  });

  it("§1.4 an RFQ whose IST deadline is still ahead is not CLOSED", async () => {
    const { ids } = await vendorList({ rfq_status: "closed" });
    expect(ids).not.toContain(rClosingIn1h);
  });

  it("§1.5 open and closed partition the seeded set — nothing lost or double-counted at the deadline moment", async () => {
    const [open, closed] = await Promise.all([
      vendorList({ rfq_status: "open" }),
      vendorList({ rfq_status: "closed" }),
    ]);
    for (const id of inserted.rfqIds) {
      const inOpen = open.ids.includes(id);
      const inClosed = closed.ids.includes(id);
      expect({ id, inOpen, inClosed }).toEqual({ id, inOpen: !inClosed, inClosed: !inOpen });
    }
  });

  it("§1.6 bid_ends_in=3d is a ROLLING 72 hours from now, not a span of calendar days", async () => {
    const { ids } = await vendorList({ bid_ends_in: "3d" });
    // Inside the rolling window.
    expect(ids).toContain(rClosingIn1h);
    expect(ids).toContain(rEndsIn2d);
    expect(ids).toContain(rInside3d); // 72h minus a minute
    // Past the window by one minute. Day-granular code counted this — it falls
    // on the same calendar day as today+3 — which is the semantic that changed.
    expect(ids).not.toContain(rJustOutside3d);
    expect(ids).not.toContain(rEndsIn4d);
    // Already closed: the lower bound is now, so a closed RFQ can never appear
    // in a "bid ends in" facet. Day-granular code kept the just-closed one here
    // for the rest of its closing day.
    expect(ids).not.toContain(rJustClosed);
    expect(ids).not.toContain(rEndedYesterday);
  });

  it("§1.7 bid_ends_in=5d widens the same rolling window without changing its shape", async () => {
    const { ids } = await vendorList({ bid_ends_in: "5d" });
    expect(ids).toContain(rJustOutside3d); // now inside
    expect(ids).toContain(rEndsIn4d);
    expect(ids).not.toContain(rJustOutside5d); // 120h plus a minute
    expect(ids).not.toContain(rJustClosed);
    expect(ids).not.toContain(rEndedYesterday);
  });

  it("§1.7b bid_ends_in=1w and 1m widen it further, still rolling from now", async () => {
    const week = await vendorList({ bid_ends_in: "1w" });
    expect(week.ids).toContain(rJustOutside5d);
    expect(week.ids).not.toContain(rJustClosed);

    const month = await vendorList({ bid_ends_in: "1m" });
    expect(month.ids).toContain(rJustOutside5d);
    expect(month.ids).not.toContain(rJustClosed);
  });

  it("§1.8 the COUNT query agrees with the list query for every bid-window facet", async () => {
    // getVendorRfqCount duplicates all six predicates from getRfqByUser. If the
    // two drift, the pager promises rows the list cannot produce.
    for (const body of [
      { rfq_status: "open" },
      { rfq_status: "closed" },
      { bid_ends_in: "3d" },
      { bid_ends_in: "5d" },
      { bid_ends_in: "1w" },
      { bid_ends_in: "1m" },
    ]) {
      const { ids, total } = await vendorList(body);
      expect(ids.length).toBeLessThan(1000); // guard: page must not be truncated
      expect({ body, total }).toEqual({ body, total: ids.length });
    }
  });

  it("§1.9 the closing_soon stat uses the same rolling 72 hours as the 3d facet", async () => {
    const before = (await vendorList({})).stats.closing_soon;

    const extraSoon = await seedRfq(await istWall("1 hour"));
    const afterSoon = (await vendorList({})).stats.closing_soon;
    expect(Number(afterSoon) - Number(before)).toBe(1);

    // An RFQ whose deadline has already passed must not count as closing soon —
    // not even one that passed a minute ago on the current IST day, which is
    // exactly what the day-granular version counted.
    await seedRfq(await istWall("-1 minute"));
    const afterJustClosed = (await vendorList({})).stats.closing_soon;
    expect(Number(afterJustClosed)).toBe(Number(afterSoon));

    // Nor one a minute past the far edge of the window.
    await seedRfq(await istWall("3 days 1 minute"));
    const afterOutside = (await vendorList({})).stats.closing_soon;
    expect(Number(afterOutside)).toBe(Number(afterSoon));

    // ...and the one that did count is genuinely in the 3d facet.
    expect((await vendorList({ bid_ends_in: "3d" })).ids).toContain(extraSoon);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §2 MOMENT family — buyer dashboard counters
// ───────────────────────────────────────────────────────────────────────────
describe("§2 buyer dashboard bid-window counters compare the full IST timestamp", () => {
  it("§2.1 an RFQ still taking bids until late tonight IST counts as active", async () => {
    // Pre-fix this read `DATE(bid_end_date) >= now()`, which truncated the
    // deadline to midnight and therefore dropped the RFQ out of "active" from
    // 00:00 on its own closing day — under every session timezone, including
    // Asia/Kolkata.
    const before = await buyerDashboard();
    await seedRfq(`${istDay(0)}T23:59:59`, { mapVendor: false });
    const after = await buyerDashboard();

    expect(after.active_rfqs).toBe(before.active_rfqs + 1);
  });

  it("§2.2 an RFQ whose IST deadline has passed does not count as active", async () => {
    const before = await buyerDashboard();
    await seedRfq(`${istDay(-1)}T23:59:59`, { mapVendor: false });
    const after = await buyerDashboard();

    expect(after.active_rfqs).toBe(before.active_rfqs);
  });

  it("§2.2b the RFQ chart's closed_rfqs series counts a passed IST deadline but not a live one", async () => {
    // getRfqChartData buckets by day over the requested range; the same
    // moment-vs-IST-now predicate decides `closed_rfqs`. A 200 here also proves
    // the rewritten SQL still parses — this route has no other coverage.
    const before = await buyerChartClosedTotal();
    await seedRfq(`${istDay(0)}T23:59:59`, { mapVendor: false });
    expect(await buyerChartClosedTotal()).toBe(before);

    await seedRfq(`${istDay(-1)}T23:59:59`, { mapVendor: false });
    expect(await buyerChartClosedTotal()).toBe(before + 1);
  });

  it("§2.3 quotes_received follows the same IST deadline, not the session midnight", async () => {
    const before = await buyerDashboard();

    const live = await seedRfq(`${istDay(0)}T23:59:59`, { mapVendor: false });
    await seedQuote(live);
    const afterLive = await buyerDashboard();
    expect(afterLive.quotes_received).toBe(before.quotes_received + 1);

    // A quote on an RFQ whose IST window has closed must not be counted.
    const expired = await seedRfq(`${istDay(-1)}T23:59:59`, { mapVendor: false });
    await seedQuote(expired);
    const afterExpired = await buyerDashboard();
    expect(afterExpired.quotes_received).toBe(afterLive.quotes_received);
  });
});
