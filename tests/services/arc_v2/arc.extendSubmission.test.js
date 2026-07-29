// ARC v2 — POST /:id/extend-submission (Sr 40 "buyer extend submission
// deadline"). Product-level: real Express app + Postgres. No mocks —
// nodemailer is globally stubbed by tests/setup/jestEnv.js, so the
// post-commit notifyArcEvent side effect is safe to let run for real; we
// don't assert on it here (out of this suite's scope).
//
// Seed pattern modeled on arc.submissionClose.test.js (direct tbl_arc INSERT
// with a controlled status/submission_end_at) + arc.quote.guards.test.js
// (vendor draft/submit guard assertions). Security scenarios (cross-tenant,
// non-creator, creator-bypass) model arc.lifecycle.states.test.js's
// "Reader fixtures" + cross-tenant block, using seedArcEvalPerms for the
// dynamically-granted arc-comm.evaluate case.

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";

const BUYER        = IDS.users.a1_proc_buyer;     // ARC creator
const NON_CREATOR  = IDS.users.a1_proc_commEval;  // same hotel, NO arc-comm.* RBAC perm by default
const EVAL_USER    = IDS.users.a1_eng_buyer;       // will be granted arc-comm.evaluate dynamically
const CROSS_TENANT = IDS.users.companyB_admin;     // Company B — no access to Hotel A1 at all
const VENDOR       = IDS.users.vendor_alpha;       // active subscription, invited
const HOTEL        = IDS.hotels.A1;
const DEPT         = IDS.departments.proc;
const HC           = IDS.hospitality.A;
const CATEGORY     = TEST_CATEGORIES.beverages;
const PROC         = IDS.processes.A_P1;

const createdArcIds = [];

function pad(n) { return String(n).padStart(2, "0"); }

// Build an IST-wall-clock "YYYY-MM-DD HH:mm" string offset from "now" by the
// given number of days (sign may be negative). Deliberately NOT using
// moment-timezone here — the point of this helper is to hand the controller
// a plain wall-clock string and later assert the DB stores those exact digits
// back, independent of the arcMomentIst/moment-timezone parsing path.
function istWallClock(offsetDays) {
  const now = new Date();
  // Shift to "IST" wall-clock digits regardless of the test runner's own TZ:
  // compute UTC epoch, add 5:30, then read UTC getters off the shifted value.
  const shifted = new Date(now.getTime() + (5 * 60 + 30) * 60_000 + offsetDays * 86_400_000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

async function insertArc({ label, status, submissionEndAt, createdBy = BUYER }) {
  const arc = await db.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
        process_id, status, created_by,
        submission_start_at, submission_end_at, contract_start_at, contract_end_at,
        eligibility_type, escalation_clause_json, sub_category_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
        NOW() - INTERVAL '20 days', $10::timestamp, NOW() + INTERVAL '20 days', NOW() + INTERVAL '200 days',
        'open','{}'::jsonb,'[]'::jsonb)
     RETURNING *`,
    [`ARC-EXT-${label}-${Date.now()}`, `Extend Submission ${label}`, CATEGORY, HC, HOTEL, DEPT, PROC, status, createdBy, submissionEndAt]
  );
  const arcId = Number(arc.id);
  createdArcIds.push(arcId);
  await db.none(`INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
                 VALUES ($1,$2,'invited') ON CONFLICT (arc_id, vendor_id) DO NOTHING`, [arcId, VENDOR]);
  const item = await db.one(
    `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
     VALUES ($1, 1, 100, 'litre') RETURNING id`, [arcId]);
  return { arcId, itemId: Number(item.id), arc };
}

async function getArc(arcId) {
  return db.one(`SELECT * FROM tbl_arc WHERE id = $1`, [arcId]);
}

async function eventRows(arcId, eventType = "deadline_extended") {
  return db.any(
    `SELECT event_type, payload FROM tbl_arc_event_log WHERE arc_id = $1 AND event_type = $2 ORDER BY id`,
    [arcId, eventType]
  );
}

let buyerClient, nonCreatorClient, evalClient, crossTenantClient, vendorClient;

beforeAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`,
    [[BUYER, NON_CREATOR, EVAL_USER, CROSS_TENANT]]);
  await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);

  // Dynamically grant EVAL_USER arc-comm.evaluate (+ arc-tech.*) scoped to
  // Hotel A1 — "no static fixture user currently holds arc-comm.evaluate"
  // (per arc.lifecycle.states.test.js's Reader-fixtures precedent).
  await seedArcEvalPerms(db, [EVAL_USER], { hospitality: HC, hotel: HOTEL });

  buyerClient      = await httpClient(BUYER);
  nonCreatorClient = await httpClient(NON_CREATOR);
  evalClient       = await httpClient(EVAL_USER);
  crossTenantClient = await httpClient(CROSS_TENANT);
  vendorClient     = await httpClient(VENDOR);
});

afterAll(async () => {
  for (const arcId of createdArcIds) {
    await db.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN (SELECT id FROM tbl_arc_quote WHERE arc_id = $1)`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = $1`, [String(arcId)]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
  }
  await cleanupArcEvalPerms(db, [EVAL_USER]);
});

describe("ARC v2 — POST /:id/extend-submission", () => {
  test("happy path: submission_closed + future extend -> 200, status flips to floated, DB updated, event logged, vendor can quote again", async () => {
    const pastEnd = istWallClock(-2); // deadline 2 days ago
    const { arcId, itemId } = await insertArc({ label: "happy", status: "submission_closed", submissionEndAt: pastEnd });

    const futureEnd = istWallClock(15); // 15 days in the future, "YYYY-MM-DD HH:mm"
    const res = await buyerClient.post(`/api/v1/arc-v2/${arcId}/extend-submission`).send({
      submission_end_at: futureEnd,
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.arc.status).toBe("floated");

    const dbArc = await getArc(arcId);
    expect(dbArc.status).toBe("floated");
    // Stored value's minute-precision digits must match what we sent (IST-naive,
    // no Date() round-trip / +5:30 shift). dbConn's OID-1114 type parser returns
    // the raw string, so a straight `startsWith` check is sufficient.
    expect(String(dbArc.submission_end_at).startsWith(futureEnd)).toBe(true);

    // A deadline_extended event was logged with reopened === true.
    const events = await eventRows(arcId);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1];
    expect(last.payload.reopened).toBe(true);
    expect(last.payload.previous_status).toBe("submission_closed");

    // The window re-opened: vendor can draft AND submit a quote again
    // (previously blocked by status !== 'floated' / closed window).
    const draft = await vendorClient.post("/api/v1/arc-v2/vendor/quote/draft").send({
      arc_id: arcId,
      lines: [{ arc_item_id: itemId, rate: 150, gst_pct: 18 }],
    });
    expect(draft.status).toBe(200);
    const submit = await vendorClient.post("/api/v1/arc-v2/vendor/quote/submit").send({ arc_id: arcId });
    expect(submit.status).toBe(200);
    expect(submit.body.data.quote.submitted_at).toBeTruthy();
  });

  test("valid extension while still 'floated' (deadline passed, sweep hasn't run): status stays floated, reopened === false", async () => {
    const pastEnd = istWallClock(-1);
    const { arcId } = await insertArc({ label: "floated-pushout", status: "floated", submissionEndAt: pastEnd });

    const futureEnd = istWallClock(10);
    const res = await buyerClient.post(`/api/v1/arc-v2/${arcId}/extend-submission`).send({
      submission_end_at: futureEnd,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.arc.status).toBe("floated");

    const dbArc = await getArc(arcId);
    expect(dbArc.status).toBe("floated");
    expect(String(dbArc.submission_end_at).startsWith(futureEnd)).toBe(true);

    const events = await eventRows(arcId);
    expect(events[events.length - 1].payload.reopened).toBe(false);
  });

  test("extend-to-past -> 400, ARC unchanged", async () => {
    const pastEnd = istWallClock(-3);
    const { arcId } = await insertArc({ label: "to-past", status: "submission_closed", submissionEndAt: pastEnd });

    const stillPast = istWallClock(-1); // in the past relative to now
    const res = await buyerClient.post(`/api/v1/arc-v2/${arcId}/extend-submission`).send({
      submission_end_at: stillPast,
    });

    expect(res.status).toBe(400);
    const dbArc = await getArc(arcId);
    expect(dbArc.status).toBe("submission_closed");
    expect(String(dbArc.submission_end_at).startsWith(pastEnd)).toBe(true);
  });

  test("extend-only guard: a future deadline EARLIER than the current one -> 400 (can only extend, not shorten), ARC unchanged", async () => {
    const currentEnd = istWallClock(20); // current deadline is 20 days out
    const { arcId } = await insertArc({ label: "no-shorten", status: "floated", submissionEndAt: currentEnd });

    const earlierButFuture = istWallClock(10); // still in the future, but BEFORE the current deadline
    const res = await buyerClient.post(`/api/v1/arc-v2/${arcId}/extend-submission`).send({
      submission_end_at: earlierButFuture,
    });

    expect(res.status).toBe(400);
    expect(String(res.body.message || "")).toMatch(/later than the current deadline|only extend/i);
    const dbArc = await getArc(arcId);
    expect(String(dbArc.submission_end_at).startsWith(currentEnd)).toBe(true); // untouched
  });

  test("invalid/unparseable submission_end_at -> 400, ARC unchanged", async () => {
    const pastEnd = istWallClock(-2);
    const { arcId } = await insertArc({ label: "bad-input", status: "submission_closed", submissionEndAt: pastEnd });

    const res = await buyerClient.post(`/api/v1/arc-v2/${arcId}/extend-submission`).send({
      submission_end_at: "not-a-date",
    });

    expect(res.status).toBe(400);
    const dbArc = await getArc(arcId);
    expect(dbArc.status).toBe("submission_closed");
    expect(String(dbArc.submission_end_at).startsWith(pastEnd)).toBe(true);
  });

  test("wrong status (tech_eval_in_progress) -> 409, ARC unchanged", async () => {
    const pastEnd = istWallClock(-2);
    const { arcId } = await insertArc({ label: "tech-eval", status: "tech_eval_in_progress", submissionEndAt: pastEnd });

    const res = await buyerClient.post(`/api/v1/arc-v2/${arcId}/extend-submission`).send({
      submission_end_at: istWallClock(10),
    });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/tech_eval_in_progress/);
    const dbArc = await getArc(arcId);
    expect(dbArc.status).toBe("tech_eval_in_progress");
    expect(String(dbArc.submission_end_at).startsWith(pastEnd)).toBe(true);
  });

  test("wrong status (contract_active, post-award) -> 409, ARC unchanged", async () => {
    const pastEnd = istWallClock(-2);
    const { arcId } = await insertArc({ label: "awarded", status: "contract_active", submissionEndAt: pastEnd });

    const res = await buyerClient.post(`/api/v1/arc-v2/${arcId}/extend-submission`).send({
      submission_end_at: istWallClock(10),
    });

    expect(res.status).toBe(409);
    const dbArc = await getArc(arcId);
    expect(dbArc.status).toBe("contract_active");
    expect(String(dbArc.submission_end_at).startsWith(pastEnd)).toBe(true);
  });

  test("wrong status (terminated) -> 409, ARC unchanged", async () => {
    const pastEnd = istWallClock(-2);
    const { arcId } = await insertArc({ label: "terminated", status: "terminated", submissionEndAt: pastEnd });

    const res = await buyerClient.post(`/api/v1/arc-v2/${arcId}/extend-submission`).send({
      submission_end_at: istWallClock(10),
    });

    expect(res.status).toBe(409);
    const dbArc = await getArc(arcId);
    expect(dbArc.status).toBe("terminated");
  });

  test("cross-tenant caller (company-B user, genuine different tenant) -> 403, ARC unchanged", async () => {
    const pastEnd = istWallClock(-2);
    const { arcId } = await insertArc({ label: "cross-tenant", status: "submission_closed", submissionEndAt: pastEnd });

    const res = await crossTenantClient.post(`/api/v1/arc-v2/${arcId}/extend-submission`).send({
      submission_end_at: istWallClock(10),
    });

    expect(res.status).toBe(403);
    const dbArc = await getArc(arcId);
    expect(dbArc.status).toBe("submission_closed");
    expect(String(dbArc.submission_end_at).startsWith(pastEnd)).toBe(true);

    // Sanity: the in-scope creator still succeeds against the same ARC.
    const allowed = await buyerClient.post(`/api/v1/arc-v2/${arcId}/extend-submission`).send({
      submission_end_at: istWallClock(10),
    });
    expect(allowed.status).toBe(200);
  });

  test("non-creator, same hotel, no arc-comm.* role -> 403", async () => {
    const pastEnd = istWallClock(-2);
    const { arcId } = await insertArc({ label: "nc-noperm", status: "submission_closed", submissionEndAt: pastEnd });

    const res = await nonCreatorClient.post(`/api/v1/arc-v2/${arcId}/extend-submission`).send({
      submission_end_at: istWallClock(10),
    });

    expect(res.status).toBe(403);
    const dbArc = await getArc(arcId);
    expect(dbArc.status).toBe("submission_closed");
    expect(String(dbArc.submission_end_at).startsWith(pastEnd)).toBe(true);
  });

  test("non-creator WITH arc-comm.evaluate (seeded) -> 200 (allowed)", async () => {
    const pastEnd = istWallClock(-2);
    const { arcId } = await insertArc({ label: "nc-withperm", status: "submission_closed", submissionEndAt: pastEnd });

    const futureEnd = istWallClock(12);
    const res = await evalClient.post(`/api/v1/arc-v2/${arcId}/extend-submission`).send({
      submission_end_at: futureEnd,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.arc.status).toBe("floated");
    const dbArc = await getArc(arcId);
    expect(String(dbArc.submission_end_at).startsWith(futureEnd)).toBe(true);
  });

  test("creator, no arc-comm.* role whatsoever -> 200 (creator bypass)", async () => {
    // BUYER (the creator) statically holds no arc-comm.*/arc-tech.* RBAC
    // permission in this suite's fixtures — confirms the unconditional
    // creator bypass works even without any ARC module role.
    const pastEnd = istWallClock(-2);
    const { arcId } = await insertArc({ label: "creator-bypass", status: "submission_closed", submissionEndAt: pastEnd, createdBy: BUYER });

    const futureEnd = istWallClock(9);
    const res = await buyerClient.post(`/api/v1/arc-v2/${arcId}/extend-submission`).send({
      submission_end_at: futureEnd,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.arc.status).toBe("floated");
  });

  test("IST-naive storage: stored submission_end_at equals the raw wall-clock string sent, no +5:30 shift", async () => {
    const pastEnd = istWallClock(-2);
    const { arcId } = await insertArc({ label: "ist-naive", status: "submission_closed", submissionEndAt: pastEnd });

    // Use an explicit, easily-diffable literal wall-clock string rather than
    // a computed one, so a +5:30 (or -5:30) shift would be unmistakable.
    const now = new Date();
    const shifted = new Date(now.getTime() + (5 * 60 + 30) * 60_000 + 7 * 86_400_000);
    const literal = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;

    const res = await buyerClient.post(`/api/v1/arc-v2/${arcId}/extend-submission`).send({
      submission_end_at: literal, // datetime-local "T" form, per the FE convention
    });
    expect(res.status).toBe(200);

    const dbArc = await getArc(arcId);
    const stored = String(dbArc.submission_end_at); // "YYYY-MM-DD HH:mm:ss"
    const [datePart, timePart] = literal.split("T");
    expect(stored.startsWith(`${datePart} ${timePart}`)).toBe(true);
  });
});
