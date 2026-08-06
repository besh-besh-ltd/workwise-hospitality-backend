// The vendor clarification window must be anchored to IST, not to the Node
// process timezone.
// ---------------------------------------------------------------------------
// `tbl_rfq.tender_publish_date` and `tbl_rfq.vendor_clarification_date` are
// `timestamp without time zone` columns holding NAIVE IST WALL-CLOCK values —
// the same convention as `bid_end_date` (app/helper/quoteVisibility.js) and the
// ARC submission window (arcTime.js). `app/config/dbConn.js` registers
// `setTypeParser(1114, s => s)`, so what reaches the controller is the literal
// string `"2026-08-06 10:00:00"` with no offset attached.
//
// `new Date("2026-08-06 10:00:00")` resolves that string in the NODE PROCESS
// timezone. Production runs the process as UTC, so every such parse landed the
// instant 5h30m LATE. `raiseClarification` compared both ends of the window
// that way, which broke it in both directions at once:
//
//   §1 WINDOW OPENS — for 5h30m after an RFQ actually published, a vendor
//      raising a clarification was told "Clarification period has not started
//      yet". The window opens late.
//
//   §2 WINDOW CLOSES — symmetrically, the window was still treated as open for
//      5h30m after `vendor_clarification_date` had passed, so late questions
//      were accepted. Because an OPEN clarification blocks EVERY vendor from
//      quoting (rfqModel.checkActiveClarification, enforced in createQuote), a
//      question accepted after the deadline can freeze the whole bid.
//
// §3 pins the sibling guard inside `createQuote` — the one that blocks quote
// submission while the clarification window is still open. That call site
// carried its own hand-rolled `Date.UTC(...) - 330min` conversion, which was
// already IST-correct; it has been collapsed onto the shared
// `getBidEndMomentIst` helper. §3 is therefore an EQUIVALENCE PIN, not a
// failing-first regression: it passed before the collapse and must keep
// passing after it. It is the evidence that one parser now serves every naive
// deadline column without a behaviour change.
//
// REPRODUCING THE TIMEZONE SKEW. Every defect here is JS-side, so the lever is
// the NODE process zone:
//
//     TZ=UTC TEST_RUN_ID=x npm test -- --ci \
//       --testPathPatterns "tests/services/rfq\.clarificationTimezone"
//
//   It has to be set on the command line. Mutating `process.env.TZ` from inside
//   a test does NOT work under Jest — the sandboxed `process.env` is a plain
//   copy without Node's native TZ setter, so `new Date()` keeps parsing in the
//   zone the process launched with (verified, not assumed).
//
//   The error is `5h30m − process_offset`, so it CHANGES SIGN east of IST
//   rather than shrinking, and the two directions need different fixtures:
//
//     - west of IST (UTC, production): the parse lands 5h30m LATE. Caught by
//       §1.1 / §2.1, whose fixtures sit 3 HOURS from the boundary — inside the
//       5h30m blind window. A fixture further out than 5h30m would land on the
//       right side of the comparison even when misread and would prove nothing.
//     - east of IST (Asia/Singapore, +08:00): the parse lands 2h30m EARLY.
//       Caught by §1.2 / §2.2, whose fixtures sit 1 HOUR from the boundary —
//       inside that smaller blind window.
//
//   So run both:
//
//     TZ=UTC             TEST_RUN_ID=x npm test -- --ci --testPathPatterns "clarificationTimezone"
//     TZ=Asia/Singapore  TEST_RUN_ID=x npm test -- --ci --testPathPatterns "clarificationTimezone"
//
//   Under an `Asia/Kolkata` process (the default on a local dev machine) there
//   is no skew to detect: the assertions stay correct but cannot discriminate.
//   That is exactly why this bug class kept shipping.
//
// Fixtures are minted from the DATABASE's own IST clock
// (`CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'`), which is invariant under
// both the Postgres session zone and the Node process zone. The fixture is
// therefore a TRUE IST wall-clock value in every configuration, and only the
// code under test can be wrong about what it means.
//
// Everything is asserted as observable behaviour — was the clarification
// accepted or refused, was the quote blocked — never on internal call counts.

import {
  describe, it, expect, afterAll, beforeEach, afterEach, jest,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import rfqController from "../../app/controllers/rfq/rfqController.js";
import { makeRFQ } from "../factories/rfq.js";

// --- Test scaffolding -------------------------------------------------------

function mockExpress(opts = {}) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    end() { return this; },
  };
  return {
    req: {
      user: opts.user || null,
      params: opts.params || {},
      body: opts.body || {},
      query: opts.query || {},
      files: opts.files || [],
    },
    res,
    next: jest.fn(),
    calls,
  };
}

const vendor = () => ({
  id: IDS.users.vendor_alpha,
  user_type: 3,
  company_id: IDS.companies.vendorAlpha,
});

/**
 * A naive IST wall-clock string at `now + interval`, in exactly the format
 * `tender_publish_date` / `vendor_clarification_date` store
 * ('YYYY-MM-DD HH:MI:SS').
 *
 * Read from the DATABASE clock via `AT TIME ZONE 'Asia/Kolkata'`, which
 * converts the absolute `CURRENT_TIMESTAMP` into IST wall clock regardless of
 * the Postgres session zone — and regardless of the Node process zone, which
 * never reaches Postgres. The fixture is thus true IST in every configuration.
 *
 * `interval` is any Postgres interval literal: '-3 hours', '1 hour'.
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

beforeEach(() => {
  inserted.rfqIds = [];
});

afterEach(async () => {
  if (!inserted.rfqIds.length) return;
  await db.none(
    `DELETE FROM tbl_rfq_clarification_message_files
     WHERE message_id IN (
       SELECT m.id FROM tbl_rfq_clarification_messages m
       JOIN tbl_rfq_clarifications c ON c.id = m.clarification_id
       WHERE c.rfq_id = ANY($1::int[])
     )`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_rfq_clarification_messages
     WHERE clarification_id IN (SELECT id FROM tbl_rfq_clarifications WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_rfq_clarification_files
     WHERE clarification_id IN (SELECT id FROM tbl_rfq_clarifications WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_rfq_clarifications WHERE rfq_id = ANY($1::int[])`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_quotes_payment_terms
     WHERE quote_id IN (SELECT id FROM tbl_quotes WHERE rfq_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
});

afterAll(async () => {
  await closeDb();
});

/** An RFQ carrying the given IST window boundaries. */
async function seedRfq({ publishAt, clarificationEndsAt, published, bidEndsAt }) {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: published ? 1 : 4,
    is_published: published ? 1 : 0,
    tender_publish_date: publishAt,
    vendor_clarification_date: clarificationEndsAt,
    bid_end_date: bidEndsAt ?? (await istWall("5 days")),
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);
  return rfq_id;
}

async function raise(rfq_id, subject = "Spec query") {
  const m = mockExpress({
    user: vendor(),
    body: { rfq_id, subject, question: "What size?" },
  });
  await rfqController.raiseClarification(m.req, m.res);
  return m.calls;
}

async function clarificationCount(rfq_id) {
  const { n } = await db.one(
    `SELECT COUNT(*)::int AS n FROM tbl_rfq_clarifications WHERE rfq_id = $1`,
    [rfq_id]
  );
  return n;
}

// ───────────────────────────────────────────────────────────────────────────
// §1 the clarification window OPENS at the IST publish moment
// ───────────────────────────────────────────────────────────────────────────
describe("§1 raiseClarification opens the window on the IST publish moment", () => {
  it("§1.1 accepts a clarification 3 hours after the IST publish moment", async () => {
    // THE HEADLINE REGRESSION. Three hours past publish, still unpublished in
    // the row (status 4) — the exact shape the sibling publish-path defect
    // leaves behind, so the two compound: the RFQ is late to publish AND its
    // vendors are told the clarification window has not opened.
    //
    // Pre-fix on a UTC process, `new Date("<IST wall, 3h ago>")` read the wall
    // clock as UTC and placed it 2h30m in the FUTURE, so `now < publishDate`
    // held and the vendor got "Clarification period has not started yet".
    //
    // Three hours is deliberate: the error is exactly +5h30m, so a fixture
    // further back than that would read as past even when misparsed and would
    // pass for the wrong reason.
    const rfq_id = await seedRfq({
      publishAt: await istWall("-3 hours"),
      clarificationEndsAt: await istWall("5 days"),
      published: false,
    });

    const calls = await raise(rfq_id);

    expect(calls.status).toBe(200);
    expect(calls.body.data.status).toBe("OPEN");
    expect(await clarificationCount(rfq_id)).toBe(1);
  });

  it("§1.2 still refuses a clarification 1 hour BEFORE the IST publish moment", async () => {
    // The other direction, and the guard that must not be loosened into
    // "always allow": on a process EAST of IST (Asia/Singapore) the same naive
    // read placed a future publish moment 2h30m in the PAST, opening the
    // clarification window on an RFQ no vendor is supposed to have seen yet.
    // One hour sits inside that 2h30m blind window.
    const rfq_id = await seedRfq({
      publishAt: await istWall("1 hour"),
      clarificationEndsAt: await istWall("5 days"),
      published: false,
    });

    const calls = await raise(rfq_id, "Too early");

    expect(calls.status).toBe(400);
    expect(calls.body.message).toMatch(/has not started/i);
    expect(await clarificationCount(rfq_id)).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §2 the clarification window CLOSES at the IST clarification deadline
// ───────────────────────────────────────────────────────────────────────────
describe("§2 raiseClarification closes the window on the IST clarification deadline", () => {
  it("§2.1 refuses a clarification 3 hours after the IST clarification deadline", async () => {
    // Pre-fix on a UTC process the deadline read 2h30m into the future, so the
    // window stayed open past its close and the question was accepted. That is
    // not a cosmetic leniency: an OPEN clarification blocks EVERY vendor on the
    // RFQ from submitting a quote, so a late question freezes the bid for
    // everyone — and the buyer has to notice and close it manually.
    //
    // Again 3 hours, i.e. inside the 5h30m blind window.
    const rfq_id = await seedRfq({
      publishAt: await istWall("-2 days"),
      clarificationEndsAt: await istWall("-3 hours"),
      published: true,
    });

    const calls = await raise(rfq_id, "Too late");

    expect(calls.status).toBe(400);
    expect(calls.body.message).toMatch(/period has ended/i);
    expect(await clarificationCount(rfq_id)).toBe(0);
  });

  it("§2.2 still accepts a clarification 1 hour BEFORE the IST clarification deadline", async () => {
    // East of IST the sign flips: a deadline still an hour away read as 1h30m
    // already past, and a vendor with time left on the clock was refused.
    const rfq_id = await seedRfq({
      publishAt: await istWall("-2 days"),
      clarificationEndsAt: await istWall("1 hour"),
      published: true,
    });

    const calls = await raise(rfq_id, "Just in time");

    expect(calls.status).toBe(200);
    expect(calls.body.data.status).toBe("OPEN");
    expect(await clarificationCount(rfq_id)).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §3 createQuote's clarification-window block, after the parser collapse
// ───────────────────────────────────────────────────────────────────────────
// EQUIVALENCE PIN — see the header. The hand-rolled conversion this replaced
// was already IST-correct, so these two pass on both sides of the change. They
// exist to prove the collapse onto `getBidEndMomentIst` preserved the boundary
// semantics exactly, in both the blocking and the non-blocking direction.
describe("§3 createQuote blocks on the IST clarification deadline", () => {
  async function seedQuotableRfq({ clarificationEndsAt }) {
    const rfq_id = await seedRfq({
      publishAt: await istWall("-2 days"),
      clarificationEndsAt,
      published: true,
      bidEndsAt: await istWall("5 days"),
    });
    await db.none(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 1, 0)`,
      [rfq_id]
    );
    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
       VALUES ($1, 1, $2, 0)`,
      [rfq_id, IDS.users.vendor_alpha]
    );
    return rfq_id;
  }

  async function submitQuote(rfq_id) {
    const m = mockExpress({
      user: vendor(),
      body: {
        rfq_id,
        rfq_no: 999501,
        status: 1,
        products: [{
          product_id: 1,
          variant: 0,
          unit_price: 500,
          tax: 18,
          tax_mode: "percentage",
          total_price: 5900,
          comment: "",
          delivery_period: "7d",
          quantity: "10",
          other_charges: [],
        }],
      },
    });
    await rfqController.createQuote(m.req, m.res, m.next);
    return m.calls;
  }

  async function quoteItemCount(rfq_id) {
    const { n } = await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_quote_items WHERE rfq_id = $1`,
      [rfq_id]
    );
    return n;
  }

  it("§3.1 blocks a quote while the IST clarification window is still open", async () => {
    // One hour of clarification time left: quoting stays shut so no vendor can
    // lock a price before the answer that might change it is published.
    const rfq_id = await seedQuotableRfq({ clarificationEndsAt: await istWall("1 hour") });

    const calls = await submitQuote(rfq_id);

    expect(calls.status).toBe(400);
    expect(calls.body.message).toMatch(/blocked until the vendor clarification period ends/i);
    expect(await quoteItemCount(rfq_id)).toBe(0);
  });

  it("§3.2 accepts a quote once the IST clarification deadline has passed", async () => {
    const rfq_id = await seedQuotableRfq({ clarificationEndsAt: await istWall("-3 hours") });

    const calls = await submitQuote(rfq_id);

    expect(calls.status).toBe(200);
    expect(await quoteItemCount(rfq_id)).toBe(1);
  });
});
