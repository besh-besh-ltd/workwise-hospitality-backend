// The RFQ auto-publish path must be anchored to IST, not to the Postgres
// session timezone or the Node process timezone.
// ---------------------------------------------------------------------------
// `tbl_rfq.tender_publish_date` is `timestamp without time zone` holding a
// NAIVE IST WALL-CLOCK value — the same convention as `bid_end_date` (see
// app/helper/quoteVisibility.js) and the ARC submission window (arcTime.js).
// It carries no offset, so:
//
//   - in SQL, comparing it against `NOW()` (timestamptz) promotes it through
//     the POSTGRES SESSION timezone, and
//   - in JS, `new Date("2026-08-06 01:10:00")` parses it in the NODE PROCESS
//     timezone.
//
// Production runs both as UTC (RDS `TimeZone = UTC`; the app never issues SET
// TIME ZONE). Both therefore placed the publish moment 5h30m LATE: an RFQ
// scheduled for 10:00 IST was not treated as due until 15:30 IST. Vendors could
// not see or quote it for that whole window and the buyer's page sat on
// "READY TO PUBLISH". Observed in staging on RFQ #535908, which was scheduled
// for 18:05 and whose AUTO_PUBLISH event landed at 18:10 UTC — 5h35m late.
//
// Three surfaces carried the defect; this suite pins all three:
//
//   §1 WATCHDOG   — runRfqStuckPublishWatchdogTick's stuck-RFQ scan
//                   (cronManager.js, SQL: `NOW()` → IST).
//   §2 FORCE      — forcePublishRfq's "has the scheduled time passed?" guard
//                   (rfqController.js, SQL: `NOW()` → IST). This is the
//                   documented escape hatch for a stuck RFQ, and it was blocked
//                   during exactly the window in which RFQs get stuck.
//   §3 SCHEDULING — scheduleRfqPublish's publish-now-vs-schedule-later decision
//                   (cronManager.js, JS: `new Date()` → IST moment).
//
// REPRODUCING THE TIMEZONE SKEW. The two families need different levers, for
// the same reason documented in rfq.bidWindowTimezone.test.js:
//
//   §1/§2 are SQL-side. `TZ=UTC` does not reach Postgres; the lever is
//   PGOPTIONS, which node-postgres reads at connect time:
//
//     PGOPTIONS="-c timezone=UTC" TEST_RUN_ID=x npm test -- --ci \
//       --testPathPatterns "tests/services/rfq\.publishTimezone"
//
//   Fixtures are placed MINUTES either side of each boundary and read from the
//   DATABASE's own IST clock, so — the error being 5h30m minus the session
//   offset — they discriminate under ANY non-IST session zone, in both
//   directions (§1.1/§2.1 catch a zone west of IST such as UTC, §1.2 catches
//   one east of it such as Asia/Singapore). Under an Asia/Kolkata session there
//   is no error to detect and they stay correct but uninformative.
//
//   §3 is JS-side, so its lever is the NODE process zone:
//
//     TZ=UTC TEST_RUN_ID=x npm test -- --ci \
//       --testPathPatterns "tests/services/rfq\.publishTimezone"
//
//   It has to be set on the command line. Mutating `process.env.TZ` from inside
//   a test does NOT work under Jest — the sandboxed `process.env` is a plain
//   copy without Node's native TZ setter, so `new Date()` keeps parsing in the
//   zone the process launched with (verified, not assumed).
//
//   Run both levers together to exercise the whole suite against the skew:
//
//     TZ=UTC PGOPTIONS="-c timezone=UTC" TEST_RUN_ID=x npm test -- --ci \
//       --testPathPatterns "tests/services/rfq\.publishTimezone"
//
// Everything is asserted as observable behaviour — did the RFQ actually become
// published, did force-publish return 200 or 400, what IST instant was handed
// to EventBridge — never on internal call counts.

import { describe, it, expect, afterAll, beforeEach, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

// --- Mocks (must be installed BEFORE importing the modules under test) ------

jest.unstable_mockModule(
  "../../app/helper/sendEmailFunctions/approvalEmails.js",
  () => ({
    sendRfqCreationNotification: async () => {},
    sendApprovalStepNotification: async () => {},
    sendRfqReadyToPublishNotification: async () => {},
    sendRfqPublishedNotification: async () => {},
    sendVendorRfqNotification: async () => {},
    sendVendorAutoAddedToRfqNotification: async () => {},
    sendVendorBulkRfqJoinNotification: async () => {},
    sendRfqClosedHeadsUpNotification: async () => {},
    sendApprovalCancelledNotification: async () => {},
    sendPolicyChangeNotification: async () => {},
    sendApproverRemovedNotification: async () => {},
    sendApprovalStandsNotification: async () => {},
    sendApproverAddedMidFlightNotification: async () => {},
  })
);

jest.unstable_mockModule(
  "../../app/helper/sendEmailFunctions/rfqPublishFailureEmail.js",
  () => ({
    sendRfqPublishFailureToCreator: async () => true,
  })
);

// Capture what would have been sent to EventBridge Scheduler instead of
// reaching the network. §3.2 asserts on the captured schedule.
const scheduleCalls = [];

jest.unstable_mockModule("@aws-sdk/client-scheduler", () => {
  // Only create/update carry a schedule definition worth capturing; group
  // creation and deletion are bookkeeping.
  class ScheduleWrite {
    constructor(params) { this.params = params; this.isScheduleWrite = true; }
  }
  class Bookkeeping {
    constructor(params) { this.params = params; }
  }
  return {
    SchedulerClient: class {
      async send(cmd) {
        if (cmd?.isScheduleWrite) scheduleCalls.push(cmd.params);
        return {};
      }
    },
    CreateScheduleCommand: ScheduleWrite,
    UpdateScheduleCommand: ScheduleWrite,
    DeleteScheduleCommand: Bookkeeping,
    GetScheduleCommand: Bookkeeping,
    ListSchedulesCommand: Bookkeeping,
    CreateScheduleGroupCommand: Bookkeeping,
  };
});

const { runRfqStuckPublishWatchdogTick, scheduleRfqPublish } = await import(
  "../../app/helper/cronManager.js"
);
const { default: rfqController } = await import("../../app/controllers/rfq/rfqController.js");

// --- Test scaffolding -------------------------------------------------------

const CREATOR = IDS.users.a1_proc_buyer;

function mockExpress(req) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    send(body) { calls.body = body; return this; },
  };
  return { req: { ...req }, res, calls };
}

/**
 * A naive IST wall-clock string at `now + interval`, in exactly the format
 * `tbl_rfq.tender_publish_date` stores ('YYYY-MM-DD HH:MI:SS').
 *
 * Read from the DATABASE clock rather than the Node clock so the fixture and
 * the SQL predicate under test agree by construction, not by the test
 * process's TZ (which never reaches Postgres).
 *
 * `interval` is any Postgres interval literal: '-10 minutes', '2 hours'.
 */
async function istWall(interval) {
  const { s } = await db.one(
    `SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') + $1::interval,
                    'YYYY-MM-DD HH24:MI:SS') AS s`,
    [interval]
  );
  return s;
}

const inserted = { rfqIds: [] };

/** A READY_TO_PUBLISH (status=4), unpublished RFQ due at `publishAtIst`. */
async function seedReadyToPublish(publishAtIst, overrides = {}) {
  const result = await makeRFQ(db, {
    createdBy: CREATOR,
    status: 4,
    is_published: 0,
    tender_publish_date: publishAtIst,
    ...overrides,
  });
  inserted.rfqIds.push(result.rfq_id);
  return result;
}

async function publishState(rfqId) {
  return db.one(
    `SELECT is_published, status FROM tbl_rfq WHERE id = $1`,
    [rfqId]
  );
}

beforeEach(() => {
  scheduleCalls.length = 0;
});

afterEach(async () => {
  if (!inserted.rfqIds.length) return;
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(
    `DELETE FROM tbl_vendor_rfq_tokens_non_login
     WHERE rfq_no IN (SELECT rfq_no FROM tbl_rfq WHERE id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  inserted.rfqIds.length = 0;
});

afterAll(async () => {
  await closeDb();
});

// ───────────────────────────────────────────────────────────────────────────
// §1 the stuck-publish watchdog scans against the IST clock
// ───────────────────────────────────────────────────────────────────────────
describe("§1 RFQ stuck-publish watchdog selects on the IST publish moment", () => {
  it("§1.1 recovers an RFQ whose IST publish moment passed 10 minutes ago", async () => {
    // THE HEADLINE REGRESSION. Pre-fix, `tender_publish_date < NOW()` read this
    // naive IST value through the session zone; under UTC that put it 5h30m in
    // the future, so the watchdog skipped the RFQ and it stayed invisible to
    // vendors until 5h32m after the moment the buyer scheduled.
    const { rfq_id } = await seedReadyToPublish(await istWall("-10 minutes"));

    await runRfqStuckPublishWatchdogTick();

    expect(await publishState(rfq_id)).toEqual({ is_published: 1, status: 1 });
  });

  it("§1.2 does NOT publish an RFQ whose IST publish moment is still 10 minutes away", async () => {
    // The other direction: under a session zone EAST of IST (e.g.
    // Asia/Singapore) the same naive read made a future publish date look
    // already-past, publishing the RFQ early and exposing it to vendors before
    // the buyer intended.
    const { rfq_id } = await seedReadyToPublish(await istWall("10 minutes"));

    await runRfqStuckPublishWatchdogTick();

    expect(await publishState(rfq_id)).toEqual({ is_published: 0, status: 4 });
  });

  it("§1.3 leaves an RFQ inside the 2-minute grace window alone", async () => {
    // 30 seconds past its IST moment — EventBridge is still expected to fire;
    // the watchdog is only a safety net and must not race it.
    const { rfq_id } = await seedReadyToPublish(await istWall("-30 seconds"));

    await runRfqStuckPublishWatchdogTick();

    expect(await publishState(rfq_id)).toEqual({ is_published: 0, status: 4 });
  });

  it("§1.4 recovers an RFQ sitting inside the 5h30m window the skew used to hide", async () => {
    // Due 3 HOURS ago in IST. The offset matters: the pre-fix error was exactly
    // +5h30m, so a fixture further back than that would be "past" even when
    // misread and would prove nothing. Three hours lands squarely inside the
    // blind window — this is the shape of staging RFQ #535917, which was still
    // unpublished hours after its 01:10 IST publish moment — and is the
    // difference between a vendor getting a 3-hour head start and not.
    const { rfq_id } = await seedReadyToPublish(await istWall("-3 hours"));

    await runRfqStuckPublishWatchdogTick();

    expect(await publishState(rfq_id)).toEqual({ is_published: 1, status: 1 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §2 force publish becomes available at the IST publish moment
// ───────────────────────────────────────────────────────────────────────────
describe("§2 forcePublishRfq gates on the IST publish moment", () => {
  it("§2.1 lets the creator force-publish once the IST publish moment has passed", async () => {
    // Pre-fix this returned 400 "Scheduled publish time has not yet passed" for
    // 5h30m after the intended moment — i.e. the manual escape hatch was shut
    // during exactly the window in which auto-publish leaves RFQs stuck, which
    // is when a buyer would reach for it.
    const { rfq_id } = await seedReadyToPublish(await istWall("-10 minutes"));

    const { req, res, calls } = mockExpress({
      params: { id: String(rfq_id) },
      user: { id: CREATOR },
    });
    await rfqController.forcePublishRfq(req, res);

    expect(calls.status).toBe(200);
    expect(await publishState(rfq_id)).toEqual({ is_published: 1, status: 1 });
  });

  it("§2.2 still refuses to force-publish before the IST publish moment", async () => {
    // The guard must not be loosened into "always allow" — an RFQ scheduled for
    // later today cannot be pushed out early.
    const { rfq_id } = await seedReadyToPublish(await istWall("60 minutes"));

    const { req, res, calls } = mockExpress({
      params: { id: String(rfq_id) },
      user: { id: CREATOR },
    });
    await rfqController.forcePublishRfq(req, res);

    expect(calls.status).toBe(400);
    expect(calls.body.message).toMatch(/has not yet passed/i);
    expect(await publishState(rfq_id)).toEqual({ is_published: 0, status: 4 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §3 the publish-now-vs-schedule-later decision, on a UTC Node process
// ───────────────────────────────────────────────────────────────────────────
// Run this section under `TZ=UTC` to reproduce the production process zone;
// see the header. Under an IST process the assertions stay correct but cannot
// discriminate, because there is no skew to detect.
describe("§3 scheduleRfqPublish decides against the IST clock, not the process clock", () => {
  it("§3.1 publishes immediately when the IST publish moment has already passed", async () => {
    // Pre-fix, `new Date("<naive IST>")` on a UTC process placed the instant
    // 5h30m late, so this RFQ looked scheduled-for-the-future. Instead of
    // publishing it now, the code handed EventBridge an `at()` expression that
    // was already in the past — a schedule that never fires — leaving the RFQ
    // stuck until the (equally skewed) watchdog eventually caught it.
    const publishAt = await istWall("-10 minutes");
    const { rfq_id, rfq_no } = await seedReadyToPublish(publishAt);

    await scheduleRfqPublish({
      id: rfq_id,
      rfq_no,
      is_tender: 0,
      tender_publish_date: publishAt,
      created_by: CREATOR,
    });

    expect(await publishState(rfq_id)).toEqual({ is_published: 1, status: 1 });
    // ...and no doomed past-dated schedule was created.
    expect(scheduleCalls).toHaveLength(0);
  });

  it("§3.2 schedules — and does not publish — when the IST publish moment is still ahead", async () => {
    const publishAt = await istWall("2 hours");
    const { rfq_id, rfq_no } = await seedReadyToPublish(publishAt);

    await scheduleRfqPublish({
      id: rfq_id,
      rfq_no,
      is_tender: 0,
      tender_publish_date: publishAt,
      created_by: CREATOR,
    });

    expect(await publishState(rfq_id)).toEqual({ is_published: 0, status: 4 });

    // EventBridge must receive the IST WALL CLOCK together with an explicit
    // Asia/Kolkata declaration. Either half alone is wrong: the wall clock
    // without the zone would fire in UTC, and a UTC instant under an IST zone
    // would fire 5h30m late.
    expect(scheduleCalls).toHaveLength(1);
    const [schedule] = scheduleCalls;
    expect(schedule.ScheduleExpressionTimezone).toBe("Asia/Kolkata");
    expect(schedule.ScheduleExpression).toBe(`at(${publishAt.replace(" ", "T")})`);
  });
});
