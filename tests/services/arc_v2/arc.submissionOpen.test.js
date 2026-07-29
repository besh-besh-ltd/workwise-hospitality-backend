// ARC v2 — Sr 27 / Option C: floated-but-not-yet-open ARCs are hidden from
// vendors, and the float notification is DEFERRED until submission_start_at
// (fired by arcSubmissionOpenService's sweep, event-log idempotent).
//
// Product-level: real Express app + real Postgres. No internal call-count
// assertions — only observable HTTP responses + DB rows.
//
// Seeded with EXPLICIT IST wall-clock literals (never NOW()), mirroring
// seedIstArc() in arc.submissionWindow.tz.test.js — a plain relative future/
// past timestamp computed via moment-timezone at module load, not a SQL
// NOW() + INTERVAL expression.

import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
import moment from 'moment-timezone';

// ── Mock sendMail so notification side-effects don't fail in CI. ────────────
// Must be set up BEFORE arcSubmissionOpenService (and, transitively, the
// arcController.js it dynamically imports) is loaded.
const mailCalls = [];
jest.unstable_mockModule('../../../app/helper/common.js', () => ({
  sendMail: async (opts) => { mailCalls.push(opts); return { messageId: '<test-open-mock>' }; },
  logError: (..._args) => { /* swallow */ },
}));

const { runArcSubmissionOpenSweep } =
  await import('../../../app/services/arcSubmissionOpenService.js');
const { ARC_EVENT_TYPES } = await import('../../../app/services/arcEventLogService.js');

import { httpClient } from '../../helpers/http.js';
import { db } from '../../setup/db.js';
import { IDS } from '../../fixtures/ids.js';
import { TEST_CATEGORIES } from '../../fixtures/vendors.js';
import { seedAutoApproveArcPolicy, cleanupArcPublishPolicy } from '../../helpers/arcPublishPolicy.js';

// ── Constants ────────────────────────────────────────────────────────────────

const IST = 'Asia/Kolkata';
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

// IST wall-clock literals (computed once at module load).
const startFut2h  = nowIst().add(2, 'hours').format('YYYY-MM-DD HH:mm:ss');
const endFut5h    = nowIst().add(5, 'hours').format('YYYY-MM-DD HH:mm:ss');
const startPast20m = nowIst().subtract(20, 'minutes').format('YYYY-MM-DD HH:mm:ss');
const endFut3h    = nowIst().add(3, 'hours').format('YYYY-MM-DD HH:mm:ss');
// A "just passed" start for the sweep test — far enough in the past that
// nowIst() at assertion time is unambiguously >= it, but recent.
const startJustPast = nowIst().subtract(5, 'minutes').format('YYYY-MM-DD HH:mm:ss');
const endFarFuture  = nowIst().add(10, 'hours').format('YYYY-MM-DD HH:mm:ss');

// ── Seeding helpers ──────────────────────────────────────────────────────────

const createdArcIds = [];
const createdPolicyIds = [];

/**
 * Seed a floated ARC directly via SQL with EXPLICIT IST wall-clock naive
 * timestamps (never NOW()), inviting vendor_alpha. Mirrors seedIstArc() in
 * arc.submissionWindow.tz.test.js.
 */
async function seedFloatedArc({ number, startAt, endAt, withTechClause = false }) {
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
             $10, 'invitation', '{}'::jsonb, '[]'::jsonb)
     RETURNING *`,
    [
      `ARC-SO-${number}-${Date.now()}`,
      `Submission-open test ${number}`,
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
       VALUES ($1, 'Sr27 open-sweep clause — must not leak pre-start', 100, 'compliance', false)`,
      [te.id]
    );
  } else {
    // Minimum viable item so the ARC is well-formed.
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 100, 'litre', 50) RETURNING id`,
      [arcId, VARIANT_ID]
    );
    itemId = Number(item.id);
  }

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

async function floatNotifRows(arcId) {
  return db.any(
    `SELECT recipient_user_id FROM tbl_notifications WHERE additional_data->>'arc_id' = $1`,
    [String(arcId)]
  );
}

async function submissionOpenedEvents(arcId) {
  return db.any(
    `SELECT id FROM tbl_arc_event_log WHERE arc_id = $1 AND event_type = $2`,
    [arcId, ARC_EVENT_TYPES.SUBMISSION_OPENED]
  );
}

async function cleanupArc(arcId) {
  await db.none(`DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = $1`, [String(arcId)]);
  await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
  await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id = $1`, [arcId]);
  await db.none(
    `DELETE FROM tbl_arc_item_tech_evaluation_clauses c
       USING tbl_arc_item_tech_evaluation te, tbl_arc_item i
      WHERE c.arc_item_tech_evaluation_id = te.id AND te.arc_item_id = i.id AND i.arc_id = $1`,
    [arcId]
  );
  await db.none(
    `DELETE FROM tbl_arc_item_tech_evaluation te USING tbl_arc_item i
      WHERE te.arc_item_id = i.id AND i.arc_id = $1`,
    [arcId]
  );
  await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1`, [arcId]);
  await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = $1`, [arcId]);
  await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('ARC v2 — Sr 27 Option C: hidden-until-open + deferred float notification', () => {
  let buyerClient, vendorClient;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR_A]);
    buyerClient  = await httpClient(BUYER);
    vendorClient = await httpClient(VENDOR_A);
  });

  afterAll(async () => {
    // Approval-instance/policy teardown first (mirrors arc.publish.vendors.test.js
    // / arc.publishApproval.test.js convention), then the ARC rows themselves.
    for (const policyId of createdPolicyIds) {
      await cleanupArcPublishPolicy({ policyId, arcIds: createdArcIds });
    }
    for (const arcId of createdArcIds) await cleanupArc(arcId);
  });

  // ── (a) Hidden before start ─────────────────────────────────────────────
  describe('(a) hidden pre-open', () => {
    let arcId;

    beforeAll(async () => {
      ({ arcId } = await seedFloatedArc({
        number: 'HIDDEN',
        startAt: startFut2h,  // IST-now + 2h
        endAt:   endFut5h,    // IST-now + 5h
        withTechClause: true,
      }));
    });

    test('GET /vendor/requests does NOT include the not-yet-open ARC', async () => {
      const res = await vendorClient.get(`${VENDOR_BASE}/requests`);
      expect(res.status).toBe(200);
      const ids = res.body.data.requests.map((r) => Number(r.id));
      expect(ids).not.toContain(arcId);
    });

    test('GET /vendor/requests/:arcId → 404', async () => {
      const res = await vendorClient.get(`${VENDOR_BASE}/requests/${arcId}`);
      expect(res.status).toBe(404);
    });

    test('GET /vendor/requests/:arcId/tech-clauses → 404 (does not leak clause text)', async () => {
      const res = await vendorClient.get(`${VENDOR_BASE}/requests/${arcId}/tech-clauses`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toMatch(/Sr27 open-sweep clause/);
    });

    // Regression cross-check (unchanged behaviour, already proven by T2 in
    // arc.submissionWindow.tz.test.js) — accept-terms still blocked pre-start.
    test('(sanity) accept-terms still 409s "not opened yet" pre-start', async () => {
      const res = await vendorClient.post(`${VENDOR_BASE}/quote/accept-terms`).send({ arc_id: arcId });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/not opened yet/i);
    });

    // Review P0: /lifecycle was leaking the full lifecycle projection for a
    // not-yet-open ARC (missing the windowNotOpen guard its siblings have).
    test('GET /vendor/requests/:arcId/lifecycle → 404 (not the full projection)', async () => {
      const res = await vendorClient.get(`${VENDOR_BASE}/requests/${arcId}/lifecycle`);
      expect(res.status).toBe(404);
    });
  });

  // ── (b) Visible once open ────────────────────────────────────────────────
  describe('(b) visible once open', () => {
    let arcId;

    beforeAll(async () => {
      ({ arcId } = await seedFloatedArc({
        number: 'VISIBLE',
        startAt: startPast20m, // IST-now - 20 min
        endAt:   endFut3h,     // IST-now + 3h
        withTechClause: true,
      }));
    });

    test('GET /vendor/requests includes the now-open ARC', async () => {
      const res = await vendorClient.get(`${VENDOR_BASE}/requests`);
      expect(res.status).toBe(200);
      const ids = res.body.data.requests.map((r) => Number(r.id));
      expect(ids).toContain(arcId);
    });

    test('GET /vendor/requests/:arcId → 200', async () => {
      const res = await vendorClient.get(`${VENDOR_BASE}/requests/${arcId}`);
      expect(res.status).toBe(200);
      expect(Number(res.body.data.arc.id)).toBe(arcId);
    });

    test('GET /vendor/requests/:arcId/tech-clauses → 200', async () => {
      const res = await vendorClient.get(`${VENDOR_BASE}/requests/${arcId}/tech-clauses`);
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeGreaterThan(0);
    });

    // Review P0 control: an already-open ARC's lifecycle stays fully readable.
    test('GET /vendor/requests/:arcId/lifecycle → 200 (control)', async () => {
      const res = await vendorClient.get(`${VENDOR_BASE}/requests/${arcId}/lifecycle`);
      expect(res.status).toBe(200);
    });
  });

  // ── (c) No immediate notification on future-start float (+ control) ────
  //
  // IMPORTANT (found while writing this suite): tbl_arc.submission_start_at /
  // submission_end_at are `timestamp without time zone` columns and the
  // create-draft insert (arcModel.js createDraft) passes the request body's
  // string straight through with NO cast/conversion. Postgres's input parser
  // for `timestamp without time zone` DISCARDS any 'Z'/offset in an ISO
  // string and stores the literal digits verbatim (verified directly:
  // `'2026-07-05T13:52:00Z'::timestamp` → `2026-07-05 13:52:00`, unchanged).
  // Since arcTime.js then reads that naive value AS IST wall-clock, feeding
  // `new Date(Date.now()+1h).toISOString()` (UTC wall-clock digits) makes the
  // literal digits ~5.5h BEHIND real IST-now — a short "+1h" future instant
  // silently becomes an ALREADY-PAST IST instant. Existing tests that create
  // via this HTTP path (arc.publish.vendors.test.js, arc.create.scope.test.js,
  // etc.) only ever use day-scale offsets, where the 5.5h skew never flips the
  // day-level sign, so this never surfaced before. For THIS suite, where we
  // need genuine short-duration future/past precision through the create
  // path, we build naive IST-formatted strings directly (no 'Z', matches what
  // the column actually stores) instead of `.toISOString()`.
  describe('(c) deferred vs. immediate float notification', () => {
    const SHARED_POLICY_ID = 64941; // one shared scope-active policy reused across both sub-tests below (avoids uq_approval_policy_scope_process collision)

    async function createAndAutoFloat({ label, submissionStartAt, submissionEndAt }) {
      await seedAutoApproveArcPolicy({
        policyId: SHARED_POLICY_ID, hospitalityCompanyId: HC, hotelId: HOTEL,
        departmentId: null, processId: PROC, createdBy: BUYER, approver: BUYER,
      });
      if (!createdPolicyIds.includes(SHARED_POLICY_ID)) createdPolicyIds.push(SHARED_POLICY_ID);

      const createRes = await buyerClient.post(`${BUYER_BASE}`).send({
        title: `Sr27 float-notify ${label}`,
        category_id: CATEGORY,
        hotel_id: HOTEL,
        department_id: DEPT,
        process_id: PROC,
        eligibility_type: 'open',
        submission_start_at: submissionStartAt,
        submission_end_at: submissionEndAt,
        contract_start_at: new Date(Date.now() + 14 * 86400_000).toISOString(),
        contract_end_at: new Date(Date.now() + 200 * 86400_000).toISOString(),
        items: [{ product_variant_id: VARIANT_ID, indicative_qty: 500, uom: 'litre' }],
      });
      expect(createRes.status).toBe(200);
      const arcId = Number(createRes.body.data.arc.id);
      createdArcIds.push(arcId);

      const pubRes = await buyerClient.post(`${BUYER_BASE}/${arcId}/publish`).send({});
      expect(pubRes.status).toBe(200);
      expect(pubRes.body.data.floated).toBe(true); // sole approver = creator → auto-floats

      return arcId;
    }

    test('future submission_start_at: float does NOT notify vendors + does NOT log submission_opened', async () => {
      const futStart = nowIst().add(1, 'hour').format('YYYY-MM-DD HH:mm:ss');
      const futEnd   = nowIst().add(7, 'days').format('YYYY-MM-DD HH:mm:ss');
      const arcId = await createAndAutoFloat({
        label: 'future', submissionStartAt: futStart, submissionEndAt: futEnd,
      });

      expect(await getArcStatus(arcId)).toBe('floated');

      const notifs = await floatNotifRows(arcId);
      expect(notifs.length).toBe(0);

      const events = await submissionOpenedEvents(arcId);
      expect(events.length).toBe(0);
    });

    test('(control) already-open submission_start_at: float DOES notify vendors + logs submission_opened immediately', async () => {
      const pastStart = nowIst().subtract(1, 'hour').format('YYYY-MM-DD HH:mm:ss');
      const futEnd    = nowIst().add(7, 'days').format('YYYY-MM-DD HH:mm:ss');
      const arcId = await createAndAutoFloat({
        label: 'immediate', submissionStartAt: pastStart, submissionEndAt: futEnd,
      });

      expect(await getArcStatus(arcId)).toBe('floated');

      const notifs = await floatNotifRows(arcId);
      expect(notifs.length).toBeGreaterThan(0);

      const events = await submissionOpenedEvents(arcId);
      expect(events.length).toBe(1);
    });
  });

  // ── (d) Open-sweep fires once, exactly once (idempotent) ────────────────
  describe('(d) open-sweep idempotency', () => {
    let arcId;

    beforeAll(async () => {
      // Simulate: floated with a future start, notify was correctly SKIPPED at
      // float time, and now (at sweep time) the start has just passed — no
      // submission_opened event logged yet.
      ({ arcId } = await seedFloatedArc({
        number: 'SWEEP',
        startAt: startJustPast, // IST-now - 5 min (due)
        endAt:   endFarFuture,
      }));
      mailCalls.length = 0;
    });

    test('first sweep run: notifies vendors + logs exactly one submission_opened event', async () => {
      expect((await floatNotifRows(arcId)).length).toBe(0);
      expect((await submissionOpenedEvents(arcId)).length).toBe(0);

      await runArcSubmissionOpenSweep({});

      const notifs = await floatNotifRows(arcId);
      expect(notifs.length).toBeGreaterThan(0);
      expect(notifs.map((r) => Number(r.recipient_user_id))).toContain(VENDOR_A);

      const events = await submissionOpenedEvents(arcId);
      expect(events.length).toBe(1);
    });

    test('second sweep run: does NOT duplicate the notification or the event', async () => {
      const before = await floatNotifRows(arcId);
      const beforeEvents = await submissionOpenedEvents(arcId);

      await runArcSubmissionOpenSweep({});

      const after = await floatNotifRows(arcId);
      const afterEvents = await submissionOpenedEvents(arcId);

      expect(after.length).toBe(before.length);
      expect(afterEvents.length).toBe(beforeEvents.length);
      expect(afterEvents.length).toBe(1);
    });
  });

  // ── (e) Submit-before-start still blocked (regression pointer) ──────────
  // Not new coverage — full regression run lives in arc.submissionWindow.tz.test.js
  // (T2) and arc.quote.guards.test.js (H2). A lightweight local cross-check:
  test('(e regression) submit-before-start on a hidden ARC is still 409', async () => {
    const { arcId } = await seedFloatedArc({
      number: 'SUBMIT-BLOCK',
      startAt: startFut2h,
      endAt:   endFut5h,
    });

    const res = await vendorClient.post(`${VENDOR_BASE}/quote/submit`).send({ arc_id: arcId });
    expect(res.status).toBe(409);
  });

  // ── (f) Dashboard hides a floated-but-not-yet-open ARC (review P1 fix) ──
  describe('(f) dashboard hides floated-but-not-yet-open ARC', () => {
    let arcId;

    beforeAll(async () => {
      ({ arcId } = await seedFloatedArc({
        number: 'DASH',
        startAt: startFut2h, // IST-now + 2h — not yet open
        endAt:   endFut5h,
      }));
      // Simulate the 'floated' event the buyer-side publish/float path logs
      // unconditionally, so we can prove it's excluded from the vendor's
      // activity feed while the ARC is still hidden.
      await db.none(
        `INSERT INTO tbl_arc_event_log (arc_id, event_type, actor_id, payload)
         VALUES ($1, 'floated', $2, '{}'::jsonb)`,
        [arcId, BUYER]
      );
    });

    test('pre-open: NOT counted open, NOT in needs_action/next_action, floated event absent from activity', async () => {
      const res = await vendorClient.get(`${VENDOR_BASE}/dashboard`);
      expect(res.status).toBe(200);
      const d = res.body.data;

      const needsArcIds = d.needs_action.map((n) => Number(n.arc_id));
      expect(needsArcIds).not.toContain(arcId);

      const nextArcId = d.next_action ? Number(d.next_action.arc_id) : null;
      expect(nextArcId).not.toBe(arcId);

      const activityArcIds = d.activity.map((e) => Number(e.arc_id));
      expect(activityArcIds).not.toContain(arcId);
    });

    test('once start passes: counted open, in needs_action, floated event visible in activity', async () => {
      // Flip ONLY submission_start_at into the IST past — mirrors what the
      // open-sweep does over time (status stays 'floated').
      await db.none(
        `UPDATE tbl_arc SET submission_start_at = $2::timestamp WHERE id = $1`,
        [arcId, startPast20m]
      );

      const res = await vendorClient.get(`${VENDOR_BASE}/dashboard`);
      expect(res.status).toBe(200);
      const d = res.body.data;

      const needsRow = d.needs_action.find((n) => Number(n.arc_id) === arcId);
      expect(needsRow).toBeTruthy();
      expect(needsRow.status).toBe('open');

      const activityRow = d.activity.find((e) => Number(e.arc_id) === arcId);
      expect(activityRow).toBeTruthy();
      expect(activityRow.event_type).toBe('floated');
    });
  });
});
