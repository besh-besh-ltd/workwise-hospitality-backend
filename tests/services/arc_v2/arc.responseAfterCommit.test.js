// ARC v2 — the HTTP response must never be written before COMMIT.
//
// Product-level: real Express app + local Postgres, no mocks. What it asserts is
// an ORDERING of two externally-meaningful events — "pg-promise issued COMMIT"
// and "the app wrote the response body" — not internal call counts or wiring.
//
// WHY THIS SUITE EXISTS
//
// Several controllers used to emit the response from INSIDE the db.tx callback:
//
//     return db.tx(async (t) => {
//       const arc = await arcModel.createDraft(data, t);
//       return ok(res, { arc }, 'ARC draft created');   // <-- before COMMIT
//     });
//
// The bytes reach the socket before pg-promise issues COMMIT, so:
//   - a client that creates then immediately re-reads can 404 on its own write
//     (the read is served by a different pooled connection, which still sees the
//     pre-commit snapshot), and
//   - if COMMIT then fails, the 200 is already sent and the error handler's 500
//     can never fire — the request reports success for work that rolled back.
//
// It also made `arc-core` shard 2 fail intermittently under
// PGOPTIONS='-c timezone=UTC', with a ROTATING victim (arc.publishApproval case
// 8, arc.publish.validation M2, ...), because the harness in tests/setup/db.js
// runs its own pg-promise pool and could observe the pre-commit state.
//
// WHY THIS IS DETERMINISTIC (the flaky suites it replaces were not)
//
// It does not race the database. Both events are recorded SERVER-SIDE, in one
// timeline, at the moment they happen:
//   - COMMIT      via pg-promise's `query` event on the app's own db instance
//                 (db.$config.options is the live options object).
//   - the response by wrapping res.json/res.end in a middleware mounted ahead of
//                 the router.
// Their relative order is fixed by the code path, so it cannot flake on timing,
// pool contention or client scheduling. A regression fails every single run.
//
// Enforced statically as well, by scripts/check-response-in-tx.mjs.

import request from "supertest";
import express from "express";
import util from "../../../app/util/index.js";
import appDb from "../../../app/config/dbConn.js";
import { loginAs } from "../../helpers/auth.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const HOTEL    = IDS.hotels.A1;
const DEPT     = IDS.departments.proc;
const BUYER    = IDS.users.a1_proc_buyer;
const CATEGORY = TEST_CATEGORIES.beverages;
const BASE     = "/api/v1/arc-v2";
const D = (days) => new Date(Date.now() + days * 86400_000).toISOString();

// ---------------------------------------------------------------------------
// Server-side event timeline
// ---------------------------------------------------------------------------
/** @type {{ kind: 'query'|'commit'|'response', sql?: string }[]} */
let timeline = [];
let recording = false;
let previousQueryHook;

/** Mount the response recorder AHEAD of the real middleware stack. */
function buildRecordingApp() {
  const app = express();
  app.use((req, res, next) => {
    let noted = false;
    const note = () => {
      if (noted || !recording) return;
      noted = true;
      timeline.push({ kind: "response" });
    };
    const origJson = res.json.bind(res);
    const origEnd = res.end.bind(res);
    res.json = (...args) => { note(); return origJson(...args); };
    res.end = (...args) => { note(); return origEnd(...args); };
    next();
  });
  util(app);
  return app;
}

/**
 * Assert the transaction that performed `writeMatcher` had COMMITTED before the
 * response was written.
 *
 * Deliberately anchored on a specific statement rather than "the response is the
 * last event": endpoints legitimately do post-response work (withdraw awaits
 * notifyArcEvent, which commits its own transactions afterwards). What must
 * never happen is the PRIMARY write's commit landing after the response.
 */
function expectCommittedBeforeResponse(writeMatcher) {
  const writeIdx = timeline.findIndex((e) => e.kind === "query" && writeMatcher.test(e.sql));
  expect(writeIdx).toBeGreaterThanOrEqual(0); // the write actually happened

  const commitIdx = timeline.findIndex((e, i) => i > writeIdx && e.kind === "commit");
  expect(commitIdx).toBeGreaterThanOrEqual(0); // it was committed, not rolled back

  const responseIdx = timeline.findIndex((e) => e.kind === "response");
  expect(responseIdx).toBeGreaterThanOrEqual(0); // a response was written

  // The invariant. On the pre-fix code this is responseIdx < commitIdx.
  expect(commitIdx).toBeLessThan(responseIdx);
}

let app;
let headers;
const createdArcs = [];

beforeAll(async () => {
  // Buyer role gate (acl[2,8]) + the category↔department mapping createDraft needs.
  await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [BUYER]);
  await db.none(
    `INSERT INTO tbl_category_department (category_id, department_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [CATEGORY, DEPT]
  );

  app = buildRecordingApp();
  headers = (await loginAs(BUYER)).headers;

  previousQueryHook = appDb.$config.options.query;
  appDb.$config.options.query = (e) => {
    if (recording) {
      const sql = String(e.query || "");
      timeline.push(/^\s*commit\b/i.test(sql) ? { kind: "commit" } : { kind: "query", sql });
    }
    if (typeof previousQueryHook === "function") previousQueryHook(e);
  };
});

afterAll(async () => {
  appDb.$config.options.query = previousQueryHook;
  for (const id of createdArcs) {
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [id]);
    await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = $1`, [id]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1`, [id]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [id]);
  }
});

beforeEach(() => {
  timeline = [];
  recording = false;
});

function req(method, path) {
  let r = request(app)[method](path);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r;
}

describe("ARC v2 — the response is written only after COMMIT", () => {
  test("createDraft commits before it responds, and the row is readable on another connection immediately", async () => {
    recording = true;
    const res = await req("post", BASE).send({
      title: "response-after-commit fixture",
      category_id: CATEGORY,
      hotel_id: HOTEL,
      department_id: DEPT,
      type: "product",
      eligibility_type: "open",
      submission_start_at: D(1),
      submission_end_at: D(7),
      contract_start_at: D(14),
      contract_end_at: D(200),
    });
    recording = false;

    expect(res.status).toBe(200);
    const arcId = Number(res.body.data.arc.id);
    createdArcs.push(arcId);

    // Deterministic: server-side ordering of INSERT -> COMMIT -> response.
    expectCommittedBeforeResponse(/INSERT INTO tbl_arc\b/i);

    // Product-level companion: the caller's own immediate read-back, on the
    // harness's SEPARATE pg-promise pool, must see the committed row. This is
    // the user-visible symptom — "created it, then 404 on it".
    const row = await db.oneOrNone(`SELECT id, status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(row).not.toBeNull();
    expect(row.status).toBe("draft");
  });

  test("withdraw commits the status flip before it responds", async () => {
    // Seed a floated ARC directly so the test does not depend on publish policy.
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, status, eligibility_type,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by)
       VALUES ($1, 'response-after-commit withdraw fixture', $2, $3, $4, $5,
               'floated', 'invitation',
               NOW() - INTERVAL '1 hour', NOW() + INTERVAL '7 days',
               NOW() + INTERVAL '14 days', NOW() + INTERVAL '200 days', $6)
       RETURNING id`,
      [`ARC-RAC-${Date.now()}`, CATEGORY, IDS.hospitality.A, HOTEL, DEPT, BUYER]
    );
    const arcId = Number(arc.id);
    createdArcs.push(arcId);

    recording = true;
    const res = await req("post", `${BASE}/${arcId}/withdraw`).send({});
    recording = false;

    expect(res.status).toBe(200);
    expect(res.body.data.arc.status).toBe("draft");

    // Deterministic: the UPDATE's transaction committed before the response.
    expectCommittedBeforeResponse(/UPDATE tbl_arc\b/i);

    // And the flip is visible on the harness's separate connection.
    const row = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(row.status).toBe("draft");
  });
});
