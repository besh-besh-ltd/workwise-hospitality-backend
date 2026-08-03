// POST /rfq/getMyRfq — the listing's scope comes from the token, not the body.
// ---------------------------------------------------------------------------
// `rfqController.getRfqByUser` used to begin:
//
//     let user_id = req.user.id;
//     if (req.body.user_id) { user_id = req.body.user_id; }
//
// and `rfqModel.getRfqByUser` then spliced that value straight into SQL text
// (`AND trpv.user_id = ${user_id}`, `WHERE created_by = '${user_id}'`). Two
// distinct defects rode on the same line:
//
//   1. IDOR — `user_id` is the ONLY thing scoping this listing, so any
//      authenticated user could read any other user's RFQ list (titles, buyer
//      company names, response emails, per-RFQ quote status) by posting the
//      victim's id.
//   2. SQL INJECTION — the value was concatenated, so it was data and SQL text
//      at once. With the sink `WHERE created_by = ${payload}`, `1` matched one
//      row and `1 OR 1=1` matched every row.
//
// The route's `validateDbBody.user_id_profileexists` guard never covered this:
// it reads `req.user.id` (userDbValidation.js:241) and never looks at
// `req.body.user_id`.
//
// The fix has two independent layers, and this suite pins BOTH — either one
// alone would let the other regress silently:
//   §1 the controller gate  — the body field is honoured only for an admin,
//                             and only as a clean positive integer.
//   §2 the model binding    — `user_id` is bound ($3/$5), never interpolated,
//                             so a payload cannot become SQL even if a future
//                             caller forgets to validate.
//
// "Admin" = tbl_users.user_type in (7, 8). See the ACT_AS_ADMIN_USER_TYPES note
// in rfqController.js for the evidence; the short version is that 7 is the type
// every `acl([7])` route already means by "admin", and it is what the one other
// `req.body.user_id` override in this codebase
// (usersController.update_user_detail:1951) checks.
//
// Everything is asserted over real HTTP against real Postgres, except §2 which
// calls the model directly — that is the point of §2, since the controller gate
// would otherwise mask whether the SQL is parameterised.
//
// Pattern B (commit + cleanup): the endpoint queries db directly, so every
// inserted id is tracked and deleted in afterAll.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";
import rfqModel from "../../app/models/rfqModel.js";

const VENDOR_A = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;
const ADMIN = IDS.users.superAdmin;
const BUYER = IDS.users.a1_proc_buyer;

const VARIANT_A = 1;
const VARIANT_B = 2;

// Payloads that are VALID SQL once concatenated into the old sinks. That is the
// property that matters: a payload which merely produces a syntax error would
// prove nothing, because a 400 looks the same whether the string was executed
// and failed to parse or was never executed at all. Each of these, spliced into
// `AND trpv.user_id = ${user_id}`, yields a well-formed predicate that matches
// every row.
const TAUTOLOGY_PAYLOADS = [
  "0 OR 1=1",
  `${VENDOR_B} OR 1=1`,
  "0 OR true",
  "0 OR 1=1 --",
];

const inserted = { rfqIds: [] };

let clientA; // vendor_alpha  (user_type 3 — an ordinary caller)
let clientB; // vendor_beta   (user_type 3)
let clientAdmin; // superAdmin (user_type 7 — may act on behalf of others)
let rfqA; // mapped to VENDOR_A only
let rfqB; // mapped to VENDOR_B only

/** Seed a published RFQ and map exactly one vendor onto it. */
async function seedRfqFor(vendorId, variantId) {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: BUYER,
    status: 1,
    is_published: 1,
    is_tender: 0,
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
    [id, variantId]
  );
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [id, variantId, vendorId]
  );
  return id;
}

/** POST the listing; returns the raw supertest response. */
function post(client, body) {
  return client.post("/api/v1/rfq/getMyRfq").send({ limit: 1000, ...body });
}

/** POST the listing and assert 200; returns { ids, total }. */
async function list(client, body = {}) {
  const res = await post(client, body);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe(1);
  return {
    ids: res.body.data.map((r) => Number(r.id)),
    total: Number(res.body.totalRFQ.count),
  };
}

beforeAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = ANY($1::int[])`, [
    [VENDOR_A, VENDOR_B],
  ]);
  await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [BUYER]);
  // Fixture users carry a NULL user_type by design; restored in afterAll.
  await db.none(`UPDATE tbl_users SET user_type = 7, status = 1 WHERE id = $1`, [ADMIN]);

  clientA = await httpClient(VENDOR_A);
  clientB = await httpClient(VENDOR_B);
  clientAdmin = await httpClient(ADMIN);

  rfqA = await seedRfqFor(VENDOR_A, VARIANT_A);
  rfqB = await seedRfqFor(VENDOR_B, VARIANT_B);
});

afterAll(async () => {
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
  await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [ADMIN]);
  await closeDb();
});

// ───────────────────────────────────────────────────────────────────────────
// §0 the legitimate path is untouched
// ───────────────────────────────────────────────────────────────────────────
describe("§0 a user still gets their own RFQs", () => {
  it("§0.1 vendor A sees their own RFQ and not vendor B's", async () => {
    const { ids } = await list(clientA);
    expect(ids).toContain(rfqA);
    expect(ids).not.toContain(rfqB);
  });

  it("§0.2 vendor B sees their own RFQ and not vendor A's", async () => {
    const { ids } = await list(clientB);
    expect(ids).toContain(rfqB);
    expect(ids).not.toContain(rfqA);
  });

  it("§0.3 the list and its COUNT twin agree", async () => {
    const { ids, total } = await list(clientA);
    expect(ids.length).toBeLessThan(1000); // guard: page not truncated
    expect(total).toBe(ids.length);
  });

  it("§0.4 echoing one's OWN id in the body is harmless, not an error", async () => {
    // A non-admin's body field is ignored rather than rejected, so a client
    // that harmlessly sends its own id keeps working unchanged.
    const baseline = await list(clientA);
    const echoed = await list(clientA, { user_id: VENDOR_A });
    expect(echoed.ids.sort()).toEqual(baseline.ids.sort());
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §1 IDOR — a non-admin cannot re-scope the listing to another user
// ───────────────────────────────────────────────────────────────────────────
describe("§1 req.body.user_id cannot re-scope the listing for a non-admin", () => {
  it("§1.1 vendor A posting vendor B's id still gets only vendor A's RFQs", async () => {
    const { ids } = await list(clientA, { user_id: VENDOR_B });
    expect(ids).not.toContain(rfqB);
    expect(ids).toContain(rfqA);
  });

  it("§1.2 the response is byte-for-byte the caller's own listing, not the victim's", async () => {
    // Stronger than §1.1: proves nothing at all leaked, including the counts
    // and stats blocks, which take user_id through separate queries.
    const own = await post(clientA, {});
    const attempted = await post(clientA, { user_id: VENDOR_B });
    expect(attempted.status).toBe(200);
    expect(attempted.body.data).toEqual(own.body.data);
    expect(attempted.body.totalRFQ).toEqual(own.body.totalRFQ);
    expect(attempted.body.stats).toEqual(own.body.stats);
  });

  it("§1.3 the id is ignored in every shape a client could send it", async () => {
    for (const value of [VENDOR_B, String(VENDOR_B), ` ${VENDOR_B} `]) {
      const { ids } = await list(clientA, { user_id: value });
      expect({ value, leaked: ids.includes(rfqB) }).toEqual({ value, leaked: false });
    }
  });

  it("§1.4 the victim's own view is unaffected by the attempt", async () => {
    await list(clientA, { user_id: VENDOR_B });
    const { ids } = await list(clientB);
    expect(ids).toContain(rfqB);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §2 SQL injection — the payload is data, never SQL
// ───────────────────────────────────────────────────────────────────────────
describe("§2 an injection payload in user_id is inert", () => {
  it("§2.1 a tautology payload from a non-admin returns exactly the caller's own rows", async () => {
    const own = await list(clientA);
    for (const payload of TAUTOLOGY_PAYLOADS) {
      const res = await post(clientA, { user_id: payload });
      expect({ payload, status: res.status }).toEqual({ payload, status: 200 });
      const ids = res.body.data.map((r) => Number(r.id));
      // Concatenated, each payload matches EVERY row. Bound or ignored, it
      // cannot widen the result set by even one row.
      expect({ payload, ids: ids.sort() }).toEqual({ payload, ids: own.ids.sort() });
      expect(ids).not.toContain(rfqB);
    }
  });

  it("§2.2 a tautology payload from an ADMIN is rejected as a malformed id", async () => {
    // The admin arm is the only one that reads the body field at all, so this
    // is where coercion has to hold. `Number('0 OR 1=1')` is NaN → 400.
    // (parseInt would have returned 0 and silently accepted the prefix.)
    for (const payload of TAUTOLOGY_PAYLOADS) {
      const res = await post(clientAdmin, { user_id: payload });
      expect({ payload, status: res.status }).toEqual({ payload, status: 400 });
    }
  });

  it("§2.3 non-integer id shapes are rejected for an admin, never coerced", async () => {
    for (const payload of ["1.5", "abc", {}, [VENDOR_B], true, "0", "-1"]) {
      const res = await post(clientAdmin, { user_id: payload });
      expect({ payload: JSON.stringify(payload), status: res.status }).toEqual({
        payload: JSON.stringify(payload),
        status: 400,
      });
    }
  });

  it("§2.4 the model binds user_id — a quote-breaking payload cannot become SQL", async () => {
    // Layer 2, asserted independently of the controller gate, against the sink
    // that had NO bound twin to accidentally save it:
    //
    //     getAllRfqBuyer:  WHERE created_by = '${user_id}'
    //
    // The interpolation sat INSIDE a string literal, so the payload below
    // closes the quote and appends a tautology, yielding the well-formed
    // `WHERE created_by = '1' OR '1'='1'` — every buyer's RFQs, for any caller.
    // (This is the exact shape the owner reproduced locally.) Bound as $5 the
    // same characters are an integer literal Postgres refuses to parse, so the
    // statement rejects instead of running.
    //
    // Called at the model layer on purpose: both HTTP callers now pass
    // `req.user.id`, so the controller can no longer deliver a payload here —
    // which is precisely why the binding needs its own pin. If a future caller
    // reintroduces untrusted input, this test is what still holds.
    const now = new Date();
    const [month, year] = [now.getMonth() + 1, now.getFullYear()];

    let rows = null;
    let rejected = false;
    try {
      rows = await rfqModel.getAllRfqBuyer(1000, 0, "1' OR '1'='1", month, year);
    } catch {
      rejected = true;
    }
    // Either outcome is safe; what must NEVER happen is the payload acting as a
    // predicate and returning RFQs the caller does not own.
    expect(rejected || rows.length === 0).toBe(true);
    if (!rejected) {
      const ids = rows.map((r) => Number(r.id));
      expect(ids).not.toContain(rfqA);
      expect(ids).not.toContain(rfqB);
    }
  });

  it("§2.5 the same binding still returns the legitimate owner's rows", async () => {
    // Guards against 'passing' §2.4 by breaking the query outright — the whole
    // point is that the value moved from SQL text to a parameter, not that the
    // statement stopped working. rfqA/rfqB were both created by BUYER this
    // month, so both must come back.
    const now = new Date();
    const rows = await rfqModel.getAllRfqBuyer(1000, 0, BUYER, now.getMonth() + 1, now.getFullYear());
    const ids = rows.map((r) => Number(r.id));
    expect(ids).toContain(rfqA);
    expect(ids).toContain(rfqB);
  });

  it("§2.6 getRfqByUser's own binding accepts an id that arrived as a JSON string", async () => {
    // JSON bodies deliver ids as strings; the $3 binding must still cast.
    const rows = await rfqModel.getRfqByUser(1000, 0, String(VENDOR_A), { search_val: null });
    expect(rows.map((r) => Number(r.id))).toContain(rfqA);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §3 the admin override is preserved, exactly as approved
// ───────────────────────────────────────────────────────────────────────────
describe("§3 an admin may still list another user's RFQs", () => {
  it("§3.1 user_type 7 gets the requested user's listing", async () => {
    const { ids } = await list(clientAdmin, { user_id: VENDOR_B });
    expect(ids).toContain(rfqB);
    expect(ids).not.toContain(rfqA);
  });

  it("§3.2 a numeric-string id is coerced, not rejected", async () => {
    const { ids } = await list(clientAdmin, { user_id: String(VENDOR_B) });
    expect(ids).toContain(rfqB);
  });

  it("§3.3 an admin sending no user_id gets their OWN listing, not everyone's", async () => {
    const { ids } = await list(clientAdmin);
    expect(ids).not.toContain(rfqA);
    expect(ids).not.toContain(rfqB);
  });

  it("§3.4 the override follows user_type, so demoting the same user closes it", async () => {
    // Pins that the gate is the *authenticated* user's type and nothing else —
    // not a header, not a body flag, not the fact that this id once worked.
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [ADMIN]);
    try {
      const { ids } = await list(clientAdmin, { user_id: VENDOR_B });
      expect(ids).not.toContain(rfqB);
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = 7 WHERE id = $1`, [ADMIN]);
    }
  });
});
