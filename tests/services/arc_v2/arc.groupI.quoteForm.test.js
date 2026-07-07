// ARC v2 — GROUP I: vendor quote-page backend-testable fixes.
//
//   Sr 36 — T&C acceptance timestamp must be stored as IST wall-clock (naive
//           column), not a bare CURRENT_TIMESTAMP (which stores whatever the
//           DB session's timezone happens to be). Idempotent (COALESCE).
//   Sr 52 — GST % is mandatory on SUBMIT (blank/null/"" rejected), but an
//           explicit 0 is a valid, distinct value (0% GST). Draft-save stays
//           tolerant of a blank GST (mirrors the rate tolerance).
//   Sr 53 — quote pricing keeps 2-decimal precision end-to-end (preview,
//           save-draft, submit, and the vendor's own read-back) — a value
//           like 30.68 must never be rounded to a whole rupee (31).
//
// Pattern: direct-SQL seeding (mirrors arc.vendor.pricing.test.js's seedArc),
// real HTTP via httpClient, real Postgres. No mocks.
//
// Sr 36 tolerance note: `NOW() AT TIME ZONE 'Asia/Kolkata'` is evaluated
// server-side by Postgres and is deterministic regardless of the Node
// process's TZ or the DB session's `timezone` GUC — so the *fixed* code
// always produces a correct IST wall-clock in any environment. What DOES
// vary by environment is how a bare `CURRENT_TIMESTAMP` write (the pre-fix
// behavior) would have been cast to the naive column, and how a naive
// timestamp gets *misread* client-side under different process timezones
// (the same class of bug documented in arc.submissionWindow.tz.test.js).
// Per the charter this file should also be run once under `TZ=UTC` to match
// that convention:
//   TZ=UTC npm test -- arc.groupI

import moment from "moment-timezone";
import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const IST = "Asia/Kolkata";
const nowIst = () => moment.tz(IST);

const HC = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const PROC = IDS.processes.A_P1;
const BUYER = IDS.users.a1_proc_buyer;
const VENDOR_A = IDS.users.vendor_alpha; // active subscription, invited
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

const VENDOR_BASE = "/api/v1/arc-v2/vendor";

const createdArcIds = [];

/** Seed a floated ARC (open submission window) with one item, invite vendor_alpha. */
async function seedArc({ number, title, itemQty = 500 }) {
  const arc = await db.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id,
        department_id, process_id, status,
        submission_start_at, submission_end_at,
        contract_start_at, contract_end_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'floated',
             NOW() - INTERVAL '2 days',
             NOW() + INTERVAL '10 days',
             NOW() + INTERVAL '30 days',
             NOW() + INTERVAL '365 days',
             $8)
     RETURNING *`,
    [number, title, CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
  );
  createdArcIds.push(Number(arc.id));

  const item = await db.one(
    `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
     VALUES ($1, $2, $3, 'litre', 100) RETURNING *`,
    [arc.id, VARIANT_ID, itemQty]
  );

  await db.none(
    `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
     VALUES ($1, $2, 'invited') ON CONFLICT (arc_id, vendor_id) DO NOTHING`,
    [Number(arc.id), VENDOR_A]
  );

  return { arcId: Number(arc.id), itemId: Number(item.id) };
}

async function acceptTerms(client, arcId) {
  return client.post(`${VENDOR_BASE}/quote/accept-terms`).send({ arc_id: arcId });
}

const parseJsonbMaybeString = (v) => (typeof v === "string" ? JSON.parse(v) : v);

// A save-draft/submit response can resolve to the HTTP client fractionally
// before the underlying db.tx()'s COMMIT lands (res.json() fires inside the
// tx callback; the COMMIT round-trip happens after). An immediate read on a
// SEPARATE pooled connection can then race a not-yet-committed write — the
// same class of flake already documented for arc.vendor.pricing.test.js's
// global-charges assertions (memory: "global-charges async race — passes on
// re-run"). Poll briefly (≤500ms) instead of asserting on a single read, so
// the test is deterministic without masking a genuine persistence bug (if the
// value is never actually persisted, this still times out and the caller's
// assertion fails against the last-seen — correctly null/stale — result).
async function retryUntil(fn, predicate, { tries = 20, delayMs = 25 } = {}) {
  let result;
  for (let i = 0; i < tries; i++) {
    result = await fn();
    if (predicate(result)) return result;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return result;
}

describe("ARC v2 — GROUP I: vendor quote-page fixes (Sr 36 / 52 / 53)", () => {
  let alphaClient;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR_A]);
    alphaClient = await httpClient(VENDOR_A);
  });

  afterAll(async () => {
    if (createdArcIds.length) {
      await db.none(
        `DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = ANY($1::text[])`,
        [createdArcIds.map(String)]
      );
      await db.none(
        `DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN
           (SELECT id FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[]))`,
        [createdArcIds]
      );
      await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [createdArcIds]);
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // Sr 52 — GST % mandatory on submit; explicit 0 valid; draft tolerant
  // ══════════════════════════════════════════════════════════════════════

  describe("Sr 52 — GST field: blank rejected on submit, explicit 0 valid, draft tolerant", () => {
    let arcId, itemId;

    beforeAll(async () => {
      ({ arcId, itemId } = await seedArc({ number: "ARC-GRPI-SR52", title: "Group I — Sr52 GST guard" }));
      const acc = await acceptTerms(alphaClient, arcId);
      expect(acc.status).toBe(200);
    });

    test("draft-save with blank (null) gst_pct is tolerant (200)", async () => {
      const res = await alphaClient.post(`${VENDOR_BASE}/quote/draft`).send({
        arc_id: arcId,
        lines: [{ arc_item_id: itemId, rate: 100, gst_pct: null }],
      });
      expect(res.status).toBe(200);
    });

    test("submit rejects a blank gst_pct — 400 with a GST-mentioning message; nothing is submitted", async () => {
      const before = await db.oneOrNone(
        `SELECT submitted_at FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`,
        [arcId, VENDOR_A]
      );
      expect(before?.submitted_at ?? null).toBeNull();

      const res = await alphaClient.post(`${VENDOR_BASE}/quote/submit`).send({ arc_id: arcId });
      expect(res.status).toBe(400);
      expect(res.body.message.toLowerCase()).toMatch(/gst/);

      // Nothing got persisted by the rejected submit — quote stays un-submitted.
      const after = await db.oneOrNone(
        `SELECT submitted_at FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`,
        [arcId, VENDOR_A]
      );
      expect(after?.submitted_at ?? null).toBeNull();
    });

    test("submit accepts an explicit gst_pct: 0 (distinct from blank) and persists 0, not null", async () => {
      const draft = await alphaClient.post(`${VENDOR_BASE}/quote/draft`).send({
        arc_id: arcId,
        lines: [{ arc_item_id: itemId, rate: 100, gst_pct: 0 }],
      });
      expect(draft.status).toBe(200);

      const submit = await alphaClient.post(`${VENDOR_BASE}/quote/submit`).send({ arc_id: arcId });
      expect(submit.status).toBe(200);
      expect(submit.body.data.quote.submitted_at).toBeTruthy();

      const line = await retryUntil(
        () => db.oneOrNone(
          `SELECT ql.gst_pct
             FROM tbl_arc_quote_line ql JOIN tbl_arc_quote q ON q.id = ql.arc_quote_id
            WHERE q.arc_id = $1 AND q.vendor_id = $2 AND ql.arc_item_id = $3`,
          [arcId, VENDOR_A, itemId]
        ),
        (row) => row?.gst_pct != null
      );
      expect(line?.gst_pct).not.toBeNull();
      expect(Number(line.gst_pct)).toBe(0);
    });

    test("draft round-trip distinguishes blank vs explicit 0 (both directions)", async () => {
      // Currently gst_pct = 0 (persisted by the previous test). Read-back must show 0.
      const lineZero = await retryUntil(
        async () => {
          const r = await alphaClient.get(`${VENDOR_BASE}/requests/${arcId}`);
          expect(r.status).toBe(200);
          return r.body.data.lines.find((l) => Number(l.arc_item_id) === itemId);
        },
        (l) => l != null && l.gst_pct != null
      );
      expect(lineZero).toBeDefined();
      expect(Number(lineZero.gst_pct)).toBe(0);

      // Blank it out again via a tolerant draft save (gst_pct: null).
      const draftBlank = await alphaClient.post(`${VENDOR_BASE}/quote/draft`).send({
        arc_id: arcId,
        lines: [{ arc_item_id: itemId, rate: 100, gst_pct: null }],
      });
      expect(draftBlank.status).toBe(200);

      const lineBlank = await retryUntil(
        async () => {
          const r = await alphaClient.get(`${VENDOR_BASE}/requests/${arcId}`);
          expect(r.status).toBe(200);
          return r.body.data.lines.find((l) => Number(l.arc_item_id) === itemId);
        },
        (l) => l != null && l.gst_pct == null
      );
      expect(lineBlank).toBeDefined();
      expect(lineBlank.gst_pct).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Sr 53 — 2-decimal precision preserved end-to-end (30.68, never 31)
  // ══════════════════════════════════════════════════════════════════════

  describe("Sr 53 — 2-decimal precision preserved end-to-end (30.68 never rounds to 31)", () => {
    let arcId, itemId;

    beforeAll(async () => {
      // qty = 1 so rate maps 1:1 onto the line base — easy to target 30.68 exactly.
      ({ arcId, itemId } = await seedArc({ number: "ARC-GRPI-SR53", title: "Group I — Sr53 2dp precision", itemQty: 1 }));
      const acc = await acceptTerms(alphaClient, arcId);
      expect(acc.status).toBe(200);
    });

    test("preview: rate 30.68 x qty 1, gst 0% → totals are 30.68, never rounded to 31", async () => {
      const res = await alphaClient.post(`${VENDOR_BASE}/quote/preview`).send({
        arc_id: arcId,
        lines: [{ arc_item_id: itemId, rate: 30.68, gst_pct: 0, gst_mode: "%", charges: [] }],
      });
      expect(res.status).toBe(200);

      const line = res.body.data.lines[0];
      expect(line.base).toBe(30.68);
      expect(line.total).toBe(30.68);
      expect(res.body.data.grand_total).toBe(30.68);
      expect(res.body.data.grand_total).not.toBe(31);
    });

    test("save-draft persists 30.68 in quote_pricing / line_pricing (not 31)", async () => {
      const draft = await alphaClient.post(`${VENDOR_BASE}/quote/draft`).send({
        arc_id: arcId,
        lines: [{ arc_item_id: itemId, rate: 30.68, gst_pct: 0, gst_mode: "%", charges: [] }],
      });
      expect(draft.status).toBe(200);

      const dbQuote = await retryUntil(
        () => db.oneOrNone(
          `SELECT quote_pricing FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`,
          [arcId, VENDOR_A]
        ),
        (row) => row?.quote_pricing != null
      );
      expect(dbQuote?.quote_pricing).not.toBeNull();
      const qp = parseJsonbMaybeString(dbQuote.quote_pricing);
      expect(Number(qp.grand_total)).toBe(30.68);
      expect(Number(qp.grand_total)).not.toBe(31);
      expect(Number(qp.grand_subtotal)).toBe(30.68);

      const dbLine = await retryUntil(
        () => db.oneOrNone(
          `SELECT ql.line_pricing
             FROM tbl_arc_quote_line ql JOIN tbl_arc_quote q ON q.id = ql.arc_quote_id
            WHERE q.arc_id = $1 AND q.vendor_id = $2 AND ql.arc_item_id = $3`,
          [arcId, VENDOR_A, itemId]
        ),
        (row) => row?.line_pricing != null
      );
      expect(dbLine?.line_pricing).not.toBeNull();
      const lp = parseJsonbMaybeString(dbLine.line_pricing);
      expect(Number(lp.total)).toBe(30.68);
      expect(Number(lp.total)).not.toBe(31);
    });

    test("submit recomputes + persists 30.68 (not 31); vendor's own read-back also shows 30.68", async () => {
      const submit = await alphaClient.post(`${VENDOR_BASE}/quote/submit`).send({ arc_id: arcId });
      expect(submit.status).toBe(200);

      const dbQuote = await retryUntil(
        () => db.oneOrNone(
          `SELECT quote_pricing, submitted_at FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`,
          [arcId, VENDOR_A]
        ),
        (row) => row?.submitted_at != null
      );
      expect(dbQuote?.submitted_at).not.toBeNull();
      const qp = parseJsonbMaybeString(dbQuote.quote_pricing);
      expect(Number(qp.grand_total)).toBe(30.68);
      expect(Number(qp.grand_subtotal)).toBe(30.68);
      expect(Number(qp.grand_total)).not.toBe(31);

      // What the vendor FE hydrates from post-submit — must also be 30.68.
      const read = await alphaClient.get(`${VENDOR_BASE}/requests/${arcId}`);
      expect(read.status).toBe(200);
      const rQp = parseJsonbMaybeString(read.body.data.quote.quote_pricing);
      expect(Number(rQp.grand_total)).toBe(30.68);

      const rLine = read.body.data.lines.find((l) => Number(l.arc_item_id) === itemId);
      const rLp = parseJsonbMaybeString(rLine.line_pricing);
      expect(Number(rLp.total)).toBe(30.68);
    });

    // The PDF `money` formatter (arcVendorController.js ~line 1196) is a local,
    // non-exported const, and the real PDF endpoint (`GET /vendor/quote/:arcId/pdf`)
    // launches a headless Puppeteer render producing binary PDF output — not
    // text-assertable without a PDF-text-extraction dependency this repo doesn't
    // carry. Per the spec's documented fallback, this is verified by source
    // inspection instead of an HTTP assertion:
    //
    //   arcVendorController.js:1196
    //   const money = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN',
    //     { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    //
    // This is the fixed 2-decimal formatter (previously
    // `Math.round(Number(n)||0)...` — whole-rupee). Confirmed present via direct
    // source read during this test-writing session (2026-07-05).
    test.skip("PDF money formatter renders 2 decimals — covered by source inspection, not HTTP (see comment above)", () => {});
  });

  // ══════════════════════════════════════════════════════════════════════
  // Sr 36 — terms_accepted_at stored as IST wall-clock (not UTC), idempotent
  // ══════════════════════════════════════════════════════════════════════

  describe("Sr 36 — terms_accepted_at is IST wall-clock (naive), idempotent", () => {
    let arcId;

    beforeAll(async () => {
      ({ arcId } = await seedArc({ number: "ARC-GRPI-SR36", title: "Group I — Sr36 IST accept-terms" }));
    });

    test("accept-terms stores an IST wall-clock naive timestamp, not a UTC one", async () => {
      const res = await alphaClient.post(`${VENDOR_BASE}/quote/accept-terms`).send({ arc_id: arcId });
      expect(res.status).toBe(200);
      expect(res.body.data.terms_accepted_at).toBeTruthy();

      // Read the RAW naive string directly (bypass the JS driver's Date
      // auto-parsing, which is itself process-TZ-dependent and would just
      // reproduce the same class of client-side misreading bug — the point
      // here is to check what Postgres actually STORED).
      const row = await retryUntil(
        () => db.oneOrNone(
          `SELECT terms_accepted_at::text AS ts_text FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`,
          [arcId, VENDOR_A]
        ),
        (r) => r?.ts_text != null
      );
      expect(row?.ts_text).toBeTruthy();

      const FMT = "YYYY-MM-DD HH:mm:ss.SSSSSS";
      const storedAsIst = moment.tz(row.ts_text, FMT, IST);
      const storedAsUtc = moment.utc(row.ts_text, FMT);

      const diffFromIstNowSec = Math.abs(nowIst().diff(storedAsIst, "seconds"));
      const diffFromUtcNowSec = Math.abs(moment.utc().diff(storedAsUtc, "seconds"));

      // The stored wall-clock, read as IST, must be ~now (small tolerance for
      // request/test latency).
      expect(diffFromIstNowSec).toBeLessThan(20);
      // Guard against a vacuous pass: if the column had (bug) stored a UTC
      // wall-clock instead, re-interpreting the SAME string as UTC would also
      // read as ~now. IST and UTC are offset by 5.5h (19800s), so at most one
      // interpretation can be close to "now" — confirm it is NOT the UTC one.
      expect(diffFromUtcNowSec).toBeGreaterThan(1000);
    });

    test("re-accepting terms is idempotent — does not move the timestamp forward", async () => {
      const before = await db.one(
        `SELECT terms_accepted_at FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`,
        [arcId, VENDOR_A]
      );
      expect(before.terms_accepted_at).toBeTruthy();

      // Short pause so a broken (non-idempotent) implementation would visibly tick.
      await new Promise((r) => setTimeout(r, 50));

      const res = await alphaClient.post(`${VENDOR_BASE}/quote/accept-terms`).send({ arc_id: arcId });
      expect(res.status).toBe(200);

      const after = await db.one(
        `SELECT terms_accepted_at FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`,
        [arcId, VENDOR_A]
      );
      // COALESCE keeps the first-write value — must be byte-for-byte unchanged.
      expect(new Date(after.terms_accepted_at).getTime()).toBe(new Date(before.terms_accepted_at).getTime());
    });
  });
});
