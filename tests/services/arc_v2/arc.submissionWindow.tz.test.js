// ARC submission-window IST fix — TZ=UTC production-environment reproduction.
//
// WHY: `submission_start_at` / `submission_end_at` are stored as IST wall-clock
// in `TIMESTAMP WITHOUT TIME ZONE` columns.  Old code used `new Date(str)` which,
// on a UTC runtime, shifted every open/close boundary +5:30 h.
//
// HOW TO REPRODUCE: run under a UTC Node process so that `new Date()` returns UTC
// and `new Date(naiveIstString)` parses the string as UTC (NOT IST).
//
// RUN: cd backend && TZ=UTC npm test -- arc.submissionWindow.tz
//
// process.env.TZ = 'UTC' below is belt-and-suspenders; the launch env var is
// authoritative and must be set for this test file to reproduce the bug.
process.env.TZ = 'UTC';

import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
import moment from 'moment-timezone';

// ── Mock sendMail so notification side-effects don't fail in CI. ────────────
// Must be set up BEFORE the arcSubmissionCloseService is dynamically imported.
const mailCalls = [];
jest.unstable_mockModule('../../../app/helper/common.js', () => ({
  sendMail: async (opts) => { mailCalls.push(opts); return { messageId: '<test-tz-mock>' }; },
  logError: (..._args) => { /* swallow */ },
}));

// Dynamic import of the cron sweep AFTER mock is registered (ES module ordering).
const { runArcSubmissionCloseSweep } =
  await import('../../../app/services/arcSubmissionCloseService.js');

import { httpClient } from '../../helpers/http.js';
import { db }         from '../../setup/db.js';
import { IDS }        from '../../fixtures/ids.js';
import { TEST_CATEGORIES } from '../../fixtures/vendors.js';

// ── Constants ───────────────────────────────────────────────────────────────

const IST = 'Asia/Kolkata';
/** Current instant in IST (timezone-independent, uses moment-timezone). */
const nowIst = () => moment.tz(IST);

const HC       = IDS.hospitality.A;
const HOTEL    = IDS.hotels.A1;
const DEPT     = IDS.departments.proc;
const PROC     = IDS.processes.A_P1;
const BUYER    = IDS.users.a1_proc_buyer;
const VENDOR_A = IDS.users.vendor_alpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

const VENDOR_BASE = '/api/v1/arc-v2/vendor';
const BUYER_BASE  = '/api/v1/arc-v2';

// ── IST wall-clock literals (computed at module load) ───────────────────────
//
// These are IST times expressed as naive strings.  When the process TZ is UTC,
// `new Date(naiveString)` misinterprets them as UTC — that is the bug.
//
// Relative (to IST-now):
const startPast   = nowIst().subtract(20, 'minutes').format('YYYY-MM-DD HH:mm:ss');
const endFuture   = nowIst().add(3, 'hours').format('YYYY-MM-DD HH:mm:ss');
const startFut2h  = nowIst().add(2, 'hours').format('YYYY-MM-DD HH:mm:ss');
const endFut5h    = nowIst().add(5, 'hours').format('YYYY-MM-DD HH:mm:ss');
const endPast1m   = nowIst().subtract(1, 'minute').format('YYYY-MM-DD HH:mm:ss');
const endPast30m  = nowIst().subtract(30, 'minutes').format('YYYY-MM-DD HH:mm:ss');
const startPast1d = nowIst().subtract(1, 'day').format('YYYY-MM-DD HH:mm:ss');

// Fixed IST literals for cron sweep tests (T5) — historical date so they are
// always in the past and never accidentally conflict with "future" logic.
//
//   CRON_END_AT   = IST '2024-06-15 18:00:00'
//   CRON_NOW_AFTER = new Date('2024-06-15T12:31:00Z')
//     → arcMomentIst converts to IST '2024-06-15 18:01:00' (1 min PAST deadline)
//
//   Bug: old code bound the JS Date as $1; Postgres session TZ=UTC coerces the naive
//   column:  '18:00:00 UTC' < '12:31:00 UTC' → FALSE → ARC NOT closed. ✗
//   Fix: binds IST-naive '18:01:00' → '18:00:00' < '18:01:00' → TRUE → closes. ✓
//
//   CRON_END_LATE = IST '2024-06-15 23:59:00'
//   CRON_NOW_SAFE = new Date('2024-06-15T14:00:00Z')
//     → arcMomentIst → IST '2024-06-15 19:30:00' (BEFORE 23:59 deadline)
const CRON_END_AT    = '2024-06-15 18:00:00';
const CRON_END_LATE  = '2024-06-15 23:59:00';
const CRON_NOW_AFTER = new Date('2024-06-15T12:31:00Z'); // IST 18:01
const CRON_NOW_SAFE  = new Date('2024-06-15T14:00:00Z'); // IST 19:30

// ── Seeding helpers ──────────────────────────────────────────────────────────

const createdArcIds = [];

/**
 * Seed a floated ARC with EXPLICIT IST wall-clock naive timestamps.
 * Never uses NOW() so the stored values represent the IST wall-clock intended,
 * regardless of the Postgres session or Node process timezone.
 */
async function seedIstArc({ number, startAt, endAt, withTechClause = false }) {
  const arc = await db.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id,
        department_id, process_id, status,
        submission_start_at, submission_end_at,
        contract_start_at, contract_end_at,
        created_by, eligibility_type, escalation_clause_json, sub_category_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'floated',
             $8::timestamp,
             $9::timestamp,
             NOW() + INTERVAL '30 days',
             NOW() + INTERVAL '365 days',
             $10, 'open', '{}'::jsonb, '[]'::jsonb)
     RETURNING *`,
    [
      `ARC-TZ-${number}-${Date.now()}`,
      `TZ submission-window test ${number}`,
      CATEGORY, HC, HOTEL, DEPT, PROC,
      startAt, endAt,
      BUYER,
    ]
  );
  const arcId = Number(arc.id);
  createdArcIds.push(arcId);

  let itemId = null;
  if (withTechClause) {
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 100, 'litre', 50) RETURNING *`,
      [arcId, VARIANT_ID]
    );
    itemId = Number(item.id);

    const te = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
       VALUES ($1, 60) RETURNING id`,
      [itemId]
    );
    await db.none(
      `INSERT INTO tbl_arc_item_tech_evaluation_clauses
         (arc_item_tech_evaluation_id, clause_text, weightage, clause_type, is_mandatory)
       VALUES ($1, 'Spec compliance clause', 100, 'compliance', false)`,
      [te.id]
    );
  }

  // Invite vendor_alpha.
  await db.none(
    `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
     VALUES ($1, $2, 'invited') ON CONFLICT (arc_id, vendor_id) DO NOTHING`,
    [arcId, VENDOR_A]
  );

  return { arcId, itemId };
}

async function getArcStatus(arcId) {
  const row = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
  return row.status;
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('ARC submission-window IST fix — TZ=UTC production-environment reproduction', () => {
  let buyerClient, vendorClient;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR_A]);
    buyerClient  = await httpClient(BUYER);
    vendorClient = await httpClient(VENDOR_A);
  });

  afterAll(async () => {
    if (!createdArcIds.length) return;

    // Clean in FK order (children first).
    await db.none(
      `DELETE FROM tbl_notifications
        WHERE additional_data->>'arc_id' = ANY($1::text[])`,
      [createdArcIds.map(String)]
    );
    await db.none(
      `DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::bigint[])`,
      [createdArcIds]
    );
    await db.none(
      `DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[])`,
      [createdArcIds]
    );
    await db.none(
      `DELETE FROM tbl_arc_item_tech_evaluation_vendors_response_files f
         USING tbl_arc_item_tech_evaluation_vendors_response r,
               tbl_arc_item_tech_evaluation_clauses c,
               tbl_arc_item_tech_evaluation te,
               tbl_arc_item i
        WHERE f.arc_item_tech_evaluation_vendors_response_id = r.id
          AND r.arc_item_tech_evaluation_clauses_id = c.id
          AND c.arc_item_tech_evaluation_id = te.id
          AND te.arc_item_id = i.id
          AND i.arc_id = ANY($1::bigint[])`,
      [createdArcIds]
    );
    await db.none(
      `DELETE FROM tbl_arc_item_tech_evaluation_vendors_response r
         USING tbl_arc_item_tech_evaluation_clauses c,
               tbl_arc_item_tech_evaluation te,
               tbl_arc_item i
        WHERE r.arc_item_tech_evaluation_clauses_id = c.id
          AND c.arc_item_tech_evaluation_id = te.id
          AND te.arc_item_id = i.id
          AND i.arc_id = ANY($1::bigint[])`,
      [createdArcIds]
    );
    await db.none(
      `DELETE FROM tbl_arc_item_tech_evaluation_clauses c
         USING tbl_arc_item_tech_evaluation te, tbl_arc_item i
        WHERE c.arc_item_tech_evaluation_id = te.id
          AND te.arc_item_id = i.id
          AND i.arc_id = ANY($1::bigint[])`,
      [createdArcIds]
    );
    await db.none(
      `DELETE FROM tbl_arc_item_tech_evaluation te
         USING tbl_arc_item i
        WHERE te.arc_item_id = i.id AND i.arc_id = ANY($1::bigint[])`,
      [createdArcIds]
    );
    await db.none(
      `DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::bigint[])`,
      [createdArcIds]
    );
    await db.none(
      `DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::bigint[])`,
      [createdArcIds]
    );
    await db.none(
      `DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`,
      [createdArcIds]
    );
  });

  // ── T1: Window opened 20 min ago in IST → accept-terms must succeed ─────
  //
  // IST-instant   │  naive string stored   │  new Date() UTC-interp    │ IST-interp (fix)
  // IST now −20m  │ '... HH:MM:SS'  (start)│ ~5h10m in the UTC-future  │ 20 min in the IST-past
  //
  // Old gate: new Date(start) > new Date() → UTC-future > UTC-now → TRUE → 409 "not opened yet"
  // Fix gate: arcMomentIst(start).isAfter(nowIst()) → IST-past isAfter IST-now → FALSE → window open
  test('T1 (bug): window opened 20 min ago IST → accept-terms succeeds (old UTC gate would 409)', async () => {
    const { arcId } = await seedIstArc({
      number: 'T1',
      startAt: startPast,   // IST-now − 20 min (stored as naive IST)
      endAt:   endFuture,   // IST-now + 3 h
    });

    const res = await vendorClient
      .post(`${VENDOR_BASE}/quote/accept-terms`)
      .send({ arc_id: arcId });

    expect(res.status).toBe(200);
    expect(res.body.data?.terms_accepted_at).toBeTruthy();
  });

  // ── T2: Window opens in 2 h (IST) → must still block with 409 ─────────
  test('T2: window opens in 2 h IST → accept-terms blocked 409 "not opened yet"', async () => {
    const { arcId } = await seedIstArc({
      number: 'T2',
      startAt: startFut2h,  // IST-now + 2 h
      endAt:   endFut5h,    // IST-now + 5 h
    });

    const res = await vendorClient
      .post(`${VENDOR_BASE}/quote/accept-terms`)
      .send({ arc_id: arcId });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/not opened yet/i);
  });

  // ── T3: Deadline passed 1 min ago in IST → must block with 409 ─────────
  //
  // IST-instant   │  naive string stored    │  new Date() UTC-interp    │ IST-interp (fix)
  // IST now −1m   │ '... HH:MM:SS'  (end)  │ ~5h29m in the UTC-future  │ 1 min in the IST-past
  //
  // Old gate: new Date(end) < new Date() → UTC-future < UTC-now → FALSE → window still "open" (WRONG)
  // Fix gate: nowIst().isSameOrAfter(arcMomentIst(end)) → IST-now ≥ IST-past → TRUE → 409 deadline
  test('T3 (bug): deadline 1 min past IST → accept-terms 409 (old UTC gate would allow it through)', async () => {
    const { arcId } = await seedIstArc({
      number: 'T3',
      startAt: startPast1d, // IST yesterday
      endAt:   endPast1m,   // IST-now − 1 min (stored as naive IST)
    });

    const res = await vendorClient
      .post(`${VENDOR_BASE}/quote/accept-terms`)
      .send({ arc_id: arcId });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/deadline|passed/i);
  });

  // ── T4: Buyer lifecycle — window closed 30 min ago IST → tech-eval unlocks ─
  //
  // Old deriveStages:
  //   windowClosed = new Date(end) < new Date()
  //   = 'IST-now−30m' parsed UTC (future by ~5h) < UTC-now (past by 30m in IST units) → FALSE
  //   → overview.window.closed = false, technical.state = 'locked' (reason: window_open) ✗
  //
  // Fix (windowClosedIst):
  //   nowIst().isSameOrAfter(arcMomentIst(end)) → IST-now ≥ IST-30m-ago → TRUE
  //   → overview.window.closed = true, technical ≠ 'locked' ✓
  test('T4 (bug): IST window closed 30 min ago → buyer lifecycle: window.closed=true + technical NOT locked', async () => {
    const { arcId } = await seedIstArc({
      number: 'T4',
      startAt: startPast1d,  // IST yesterday
      endAt:   endPast30m,   // IST-now − 30 min
      withTechClause: true,
    });

    // GET lifecycle with lazyFlip=true (default on this endpoint).
    const res = await buyerClient.get(`${BUYER_BASE}/${arcId}/lifecycle`);
    expect(res.status).toBe(200);

    const { stages } = res.body.data;
    const overview  = stages.find((s) => s.key === 'overview');
    const technical = stages.find((s) => s.key === 'technical');

    expect(overview).toBeDefined();
    expect(technical).toBeDefined();

    // The fix must report the window as closed.
    expect(overview.window.closed).toBe(true);
    expect(overview.state).toBe('complete');

    // Technical must NOT be gated on the still-open (UTC-interpreted) window.
    expect(technical.state).not.toBe('locked');
    if (technical.reason) {
      expect(technical.reason).not.toBe('window_open');
    }
  });

  // ── T5a: Cron sweep closes ARC whose IST deadline just passed ─────────────
  //
  // ARC `submission_end_at` = '2024-06-15 18:00:00' (IST wall-clock)
  // Injected `now` = new Date('2024-06-15T12:31:00Z')
  //   → arcMomentIst converts UTC 12:31 to IST '2024-06-15 18:01:00' (1 min past deadline)
  //
  // Old cron: bound JS Date as $1 (timestamptz).
  //   Postgres session TZ=UTC coerces naive column: '18:00:00 UTC' < '12:31:00Z' → FALSE → NOT closed ✗
  // Fix:  binds IST-naive '18:01:00'; comparison is naive < naive: '18:00:00' < '18:01:00' → TRUE → closed ✓
  test('T5a (cron bug): sweep closes ARC whose IST deadline just passed (UTC-Postgres would not have)', async () => {
    const { arcId } = await seedIstArc({
      number: 'T5A',
      startAt: '2024-06-15 08:00:00', // fixed IST past start
      endAt:   CRON_END_AT,            // '2024-06-15 18:00:00' IST
    });
    mailCalls.length = 0;

    // Inject IST-18:01 as UTC Date; arcMomentIst inside the service converts it correctly.
    await runArcSubmissionCloseSweep({ now: CRON_NOW_AFTER });

    expect(await getArcStatus(arcId)).toBe('submission_closed');
  });

  // ── T5b: Cron does NOT close ARC whose IST deadline is still future ────────
  //
  // ARC `submission_end_at` = '2024-06-15 23:59:00' (IST)
  // Injected `now` = new Date('2024-06-15T14:00:00Z')
  //   → arcMomentIst → IST '2024-06-15 19:30:00' (BEFORE 23:59 deadline)
  // Fix: naive '23:59:00' < naive '19:30:00' → FALSE → stays floated ✓
  test('T5b (regression): cron does NOT close ARC whose IST deadline is 4 h away', async () => {
    const { arcId } = await seedIstArc({
      number: 'T5B',
      startAt: '2024-06-15 08:00:00',
      endAt:   CRON_END_LATE,          // '2024-06-15 23:59:00' IST
    });

    await runArcSubmissionCloseSweep({ now: CRON_NOW_SAFE }); // IST 19:30, before 23:59

    expect(await getArcStatus(arcId)).toBe('floated');
  });
});
