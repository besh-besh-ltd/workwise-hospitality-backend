// Security regression suite for the SQL-injection sinks that survived commit
// e7a31f0d ("fix(negotiation): security, activation, statuses and PO totals").
//
// That commit hardened `rfqModel.checkIfExists` / `.update` / `.updateWhere`:
// the legacy string form of the condition now fails closed on statement-
// breakout tokens (`;`, `--`, comment markers, NUL), which kills the STACKED-
// STATEMENT class everywhere at once. What it deliberately did NOT do is stop
// BOOLEAN injection — `1 OR 1=1`, `1) OR (1=1` — because that needs each call
// site converted to the parameterized `{ where, values }` form.
//
// This suite covers the call sites that were still building their WHERE clause
// by string interpolation from request data:
//
//   PRIMARY — validateDbBody.negotiateModule (app/validations/dbValidation/
//     userDbValidation.js), the only gate on `POST /api/v1/rfq/negotiate`.
//     `productId` and every element of the `vendorIds` array came straight off
//     req.body into `id = ${productId}` and `id IN (${vendorIds.join(",")})`.
//     Both are UNQUOTED numeric contexts, so no quote-escape is even needed.
//     The route is `passportSignIn` only — no acl(), no Joi body schema, no
//     tenant check — so any authenticated account on the platform, buyer or
//     vendor, of any tenant, could reach it.
//
//   SWEEP — the same pattern in:
//     buyerController.updateBuyerAccountLimits   (an UPDATE sink — mass write)
//     buyerController.reviewBuyerPrivateVendors
//     productController.updateVariantVendorMapping
//     projectController.getProjectAvailableBudget
//     hospitalityController.getRFQHotels
//
// Per tests/CONVENTIONS.md §3 these run over real HTTP through the full
// middleware chain against local Postgres. The clause-level tests call the
// production model function with the exact string the call site used to build.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import JWT from "jsonwebtoken";
import Cryptr from "cryptr";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { makeRFQ } from "../factories/rfq.js";
import Config from "../../app/config/app.config.js";
import rfqModel from "../../app/models/rfqModel.js";

const BUYER = IDS.users.a1_proc_buyer;
const VENDOR_A = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;

// An id that exists in no table in the fixture set.
const GHOST_ID = 999999999;

// The routes under /api/v1/admin authenticate with passport's `jwtAdm`
// strategy, not the `jwtUsr` one tests/helpers/auth.js signs for. jwtAdm wants
// `payload.admin` truthy and resolves the principal out of tbl_users all the
// same, so a fixture user works — it just needs a differently-shaped token.
const cryptr = new Cryptr(Config.cryptR.secret);
const TEST_USER_AGENT = "jest-test-agent";

async function adminClient(userId) {
  const { app } = await httpClient(null);
  const now = Math.round(Date.now() / 1000);
  const token = JWT.sign(
    {
      iss: "Des Technico",
      sub: cryptr.encrypt(String(userId)),
      admin: true,
      ag: cryptr.encrypt(TEST_USER_AGENT),
      iat: now,
      exp: now + 3600,
    },
    Config.jwt.secret
  );
  const headers = { Authorization: `Bearer ${token}`, "User-Agent": TEST_USER_AGENT };
  const wrap = (method) => (path) => {
    let req = request(app)[method](path);
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return req;
  };
  return { get: wrap("get"), post: wrap("post"), put: wrap("put") };
}

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
//  PRIMARY — POST /api/v1/rfq/negotiate  (validateDbBody.negotiateModule)
// ---------------------------------------------------------------------------

describe("SQLi — POST /rfq/negotiate (validateDbBody.negotiateModule)", () => {
  let rfqId;
  let rfqProductId;

  beforeAll(async () => {
    const { rfq_id } = await makeRFQ(db, { createdBy: BUYER, status: 1, is_published: 1 });
    rfqId = rfq_id;
    const row = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 1, 0) RETURNING id`,
      [rfqId]
    );
    rfqProductId = row.id;
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_rfq_product_target_price WHERE tbl_rfq_product_id = $1`, [rfqProductId]);
    await db.none(`DELETE FROM tbl_quote_activity WHERE rfq_id = $1`, [rfqId]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = $1`, [rfqId]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = $1`, [rfqId]);
  });

  beforeEach(async () => {
    await db.none(`DELETE FROM tbl_rfq_product_target_price WHERE tbl_rfq_product_id = $1`, [rfqProductId]);
  });

  const negotiate = async (body, userId = BUYER) => {
    const client = await httpClient(userId);
    return client.post("/api/v1/rfq/negotiate").send(body);
  };

  const targetPriceRows = () =>
    db.any(`SELECT * FROM tbl_rfq_product_target_price WHERE tbl_rfq_product_id = $1`, [rfqProductId]);

  // -- the vulnerability itself, at the clause level --------------------------

  it("REPRO: the interpolated `id IN (...)` clause lets one array element rewrite the query", async () => {
    // Exactly what the call site built: vendorIds.join(",") spliced into an
    // unquoted numeric IN-list. One element closes the paren and ORs on its
    // own predicate, so a vendor the caller never named comes back.
    const evil = `${GHOST_ID}) OR (id = ${VENDOR_A}`;
    const rows = await rfqModel.checkIfExists("tbl_users", `id IN (${[evil].join(",")})`);

    expect(rows).toHaveLength(1);
    expect(Number(rows[0].id)).toBe(VENDOR_A);

    // ...and because the count matches the array length, the validator's
    // "do all these vendors exist?" test passes for an id that does not exist.
    expect(rows.length).toBe([evil].length);
  });

  it("REPRO: the interpolated clause is a blind boolean oracle over any table", async () => {
    // Same shape, but the injected predicate reads a table the caller was
    // never granted. Row count flips with the answer — one bit per request is
    // enough to walk any column in the database.
    const oracle = (predicate) =>
      rfqModel.checkIfExists("tbl_users", `id IN (${-1}) OR (id = ${VENDOR_A} AND ${predicate})`);

    const whenTrue = await oracle(`(SELECT count(*) FROM tbl_users WHERE id > 0) > 0`);
    const whenFalse = await oracle(`(SELECT count(*) FROM tbl_users WHERE id > 0) < 0`);

    expect(whenTrue).toHaveLength(1);
    expect(whenFalse).toHaveLength(0);
  });

  it("the parameterized array form cannot be subverted by a crafted element", async () => {
    const evil = `${GHOST_ID}) OR (id = ${VENDOR_A}`;
    // A crafted element stays a VALUE. Postgres rejects it as a non-integer
    // rather than compiling it as SQL.
    await expect(
      rfqModel.checkIfExists("tbl_users", { where: "id = ANY($1::int[])", values: [[evil]] })
    ).rejects.toThrow();

    // A legitimate array resolves exactly the ids asked for.
    const rows = await rfqModel.checkIfExists("tbl_users", {
      where: "id = ANY($1::int[])",
      values: [[VENDOR_A, VENDOR_B]],
    });
    expect(rows.map((r) => Number(r.id)).sort()).toEqual([VENDOR_A, VENDOR_B].sort());
  });

  // -- the endpoint ----------------------------------------------------------

  it("rejects a crafted vendorIds element instead of letting it rewrite the query", async () => {
    const res = await negotiate({
      rfq_id: rfqId,
      productId: rfqProductId,
      targetPrice: 100,
      // Pre-fix this passed the "all vendors exist" check for GHOST_ID.
      vendorIds: [`${GHOST_ID}) OR (id = ${VENDOR_A}`],
    });

    expect(res.status).toBe(400);
    expect(await targetPriceRows()).toHaveLength(0);
  });

  it("kills the boolean oracle — two crafted payloads differing only in the injected predicate respond identically", async () => {
    const ask = (predicate) =>
      negotiate({
        rfq_id: rfqId,
        productId: rfqProductId,
        targetPrice: 100,
        vendorIds: [`-1) OR (id = ${VENDOR_A} AND ${predicate}`],
      });

    const truthy = await ask(`(SELECT count(*) FROM tbl_users WHERE id > 0) > 0`);
    const falsy = await ask(`(SELECT count(*) FROM tbl_users WHERE id > 0) < 0`);

    // Pre-fix the oracle answered: "true" passed validation, "false" 404'd.
    expect(truthy.status).toBe(400);
    expect(falsy.status).toBe(400);
    expect(truthy.body.message).toBe(falsy.body.message);
  });

  it("rejects a crafted productId instead of matching every RFQ product", async () => {
    const res = await negotiate({
      rfq_id: rfqId,
      // `id = 999999999 OR 1=1` matched every row in tbl_rfq_products, so a
      // product id that does not exist sailed through the existence check.
      productId: `${GHOST_ID} OR 1=1`,
      targetPrice: 100,
      vendorIds: [VENDOR_A],
    });

    expect(res.status).toBe(400);
    expect(await targetPriceRows()).toHaveLength(0);
  });

  it("a statement-breakout payload is rejected cleanly and the canary survives", async () => {
    await db.none(`DROP TABLE IF EXISTS tbl_sqli_canary_neg`);
    await db.none(`CREATE TABLE tbl_sqli_canary_neg (id int)`);
    try {
      const res = await negotiate({
        rfq_id: rfqId,
        productId: rfqProductId,
        targetPrice: 100,
        vendorIds: [`1); DROP TABLE tbl_sqli_canary_neg; --`],
      });

      // Pre-fix checkIfExists threw (breakout guard) and the validator turned
      // that into a 500 — the table survived, but on an unhandled error path.
      expect(res.status).toBe(400);

      const canary = await db.one(`SELECT to_regclass('public.tbl_sqli_canary_neg') AS t`);
      expect(canary.t).not.toBeNull();
    } finally {
      await db.none(`DROP TABLE IF EXISTS tbl_sqli_canary_neg`);
    }
  });

  // -- behaviour that must NOT change ---------------------------------------

  it("REGRESSION: a legitimate negotiate request still succeeds and writes target prices", async () => {
    const res = await negotiate({
      rfq_id: rfqId,
      productId: rfqProductId,
      targetPrice: 250,
      vendorIds: [VENDOR_A, VENDOR_B],
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    const rows = await targetPriceRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => Number(r.vendor_id)).sort()).toEqual([VENDOR_A, VENDOR_B].sort());
    expect(rows.every((r) => Number(r.target_price) === 250)).toBe(true);
  });

  it("REGRESSION: numeric-string ids (what the browser actually posts) still succeed", async () => {
    const res = await negotiate({
      rfq_id: String(rfqId),
      productId: String(rfqProductId),
      targetPrice: 300,
      vendorIds: [String(VENDOR_A)],
    });

    expect(res.status).toBe(200);
    expect(await targetPriceRows()).toHaveLength(1);
  });

  it("REGRESSION: a well-formed but nonexistent productId still 404s with the same message", async () => {
    const res = await negotiate({
      rfq_id: rfqId,
      productId: GHOST_ID,
      targetPrice: 100,
      vendorIds: [VENDOR_A],
    });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Provide a valid Product ID");
  });

  it("REGRESSION: a well-formed but nonexistent vendorId still 404s with the same message", async () => {
    const res = await negotiate({
      rfq_id: rfqId,
      productId: rfqProductId,
      targetPrice: 100,
      vendorIds: [VENDOR_A, GHOST_ID],
    });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Some vendor IDs do not exist");
  });

  it("REGRESSION: the missing-input 400 is unchanged", async () => {
    const res = await negotiate({ rfq_id: rfqId, targetPrice: 100, vendorIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Missing productId or vendorIds");
  });
});

// ---------------------------------------------------------------------------
//  SWEEP 1 — PUT /api/v1/admin/buyer/update-account-limits/:company_id
//  rfqModel.updateWhere — an UPDATE sink, so injection is a mass WRITE.
// ---------------------------------------------------------------------------

describe("SQLi — PUT /admin/buyer/update-account-limits/:company_id", () => {
  const COMPANY_A = IDS.companies.A;
  const COMPANY_B = IDS.companies.B;

  const seedLimits = async () => {
    await db.none(`DELETE FROM tbl_company_buyer_account_limit WHERE company_id = ANY($1::int[])`, [
      [COMPANY_A, COMPANY_B],
    ]);
    await db.none(
      `INSERT INTO tbl_company_buyer_account_limit
         (company_id, max_top_management, max_procurement, max_engineering, max_finance)
       VALUES ($1,1,1,1,1), ($2,1,1,1,1)`,
      [COMPANY_A, COMPANY_B]
    );
  };

  beforeEach(seedLimits);

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_company_buyer_account_limit WHERE company_id = ANY($1::int[])`, [
      [COMPANY_A, COMPANY_B],
    ]);
  });

  const putLimits = async (companyIdSegment, body) => {
    const client = await adminClient(BUYER);
    return client
      .put(`/api/v1/admin/buyer/update-account-limits/${companyIdSegment}`)
      .send(body);
  };

  const limits = () =>
    db.any(
      `SELECT company_id, max_procurement FROM tbl_company_buyer_account_limit
        WHERE company_id = ANY($1::int[]) ORDER BY company_id`,
      [[COMPANY_A, COMPANY_B]]
    );

  it("REPRO: the interpolated WHERE rewrote EVERY company's limits", async () => {
    // `company_id = -1 OR 1=1` — the exact clause the controller built.
    await rfqModel.updateWhere(
      "tbl_company_buyer_account_limit",
      { max_procurement: 999 },
      `company_id = ${"-1 OR 1=1"}`
    );
    const rows = await limits();
    expect(rows.map((r) => Number(r.max_procurement))).toEqual([999, 999]);
  });

  it("a crafted :company_id cannot touch another company's row", async () => {
    const res = await putLimits(encodeURIComponent("-1 OR 1=1"), {
      max_top_management: 999,
      max_procurement: 999,
      max_engineering: 999,
      max_finance: 999,
    });

    expect(res.status).toBe(400);
    const rows = await limits();
    expect(rows.map((r) => Number(r.max_procurement))).toEqual([1, 1]);
  });

  it("REGRESSION: a legitimate company_id updates exactly that company", async () => {
    const res = await putLimits(COMPANY_A, {
      max_top_management: 5,
      max_procurement: 6,
      max_engineering: 7,
      max_finance: 8,
    });

    expect(res.status).toBe(200);
    const rows = await limits();
    expect(rows.map((r) => [Number(r.company_id), Number(r.max_procurement)])).toEqual([
      [COMPANY_A, 6],
      [COMPANY_B, 1],
    ]);
  });
});

// ---------------------------------------------------------------------------
//  SWEEP 2 — PUT /api/v1/admin/buyer/review-buyers-private-vendor
// ---------------------------------------------------------------------------

describe("SQLi — PUT /admin/buyer/review-buyers-private-vendor", () => {
  // The route is acl([1]); fixture users carry user_type NULL, so borrow one
  // for the duration of this block and put it back afterwards.
  const ADMIN = IDS.users.superAdmin;
  const VICTIM_EMAIL = "sqli.temp.vendor@test.local";
  let tempUserId;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 1 WHERE id = $1`, [ADMIN]);
  });

  afterAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [ADMIN]);
  });

  // tbl_temp_user is not part of the fixture set (nothing seeds it), so this
  // block owns the table outright — which makes `userDetails[0]` under an
  // injected id deterministically the row seeded here.
  beforeEach(async () => {
    await db.none(`DELETE FROM tbl_temp_user`);
    const row = await db.one(
      `INSERT INTO tbl_temp_user (buyer_id, vendor_name, email, mobile, product_list, status, is_private)
       VALUES ($1, 'SQLi Temp Vendor', $2, '9990001111', 'x', -1, 1)
       RETURNING id`,
      [BUYER, VICTIM_EMAIL]
    );
    tempUserId = row.id;
  });

  afterEach(async () => {
    await db.none(`DELETE FROM tbl_temp_user WHERE email = $1`, [VICTIM_EMAIL]);
  });

  const review = async (body) => {
    const client = await adminClient(ADMIN);
    return client.put("/api/v1/admin/buyer/review-buyers-private-vendor").send(body);
  };

  it("REPRO: the interpolated WHERE matched every pending temp user", async () => {
    const rows = await rfqModel.checkIfExists("tbl_temp_user", `id = ${"-1 OR 1=1"}`);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("a crafted vendorTempId is not treated as an existing temp vendor", async () => {
    // `status: 99` is not one of the handled branches, so the response tells
    // us exactly how far the request got:
    //   "user not exist"  → the existence check correctly found nothing
    //   "Invalid status"  → the existence check MATCHED and we fell through
    // Pre-fix an injected id produced "Invalid status": `id = -1 OR 1=1`
    // matched every pending temp vendor, so `userDetails[0]` was somebody the
    // admin never named.
    const res = await review({ vendorTempId: "-1 OR 1=1", status: 99 });

    expect(res.body.message).not.toBe("Invalid status");
    expect(res.status).toBe(400);
  });

  it("a crafted vendorTempId cannot act on somebody else's temp vendor", async () => {
    const res = await review({ vendorTempId: "-1 OR 1=1", status: 2, reject_reason: "pwn" });

    expect(res.status).toBe(400);
    // Nothing was rejected on the injected id's behalf.
    const row = await db.one(`SELECT status FROM tbl_temp_user WHERE id = $1`, [tempUserId]);
    expect(Number(row.status)).toBe(-1);
  });

  it("REGRESSION: a well-formed nonexistent id short-circuits before the status branch", async () => {
    const res = await review({ vendorTempId: GHOST_ID, status: 99 });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("user not exist");
  });

  it("REGRESSION: a legitimate vendorTempId still rejects that vendor", async () => {
    const res = await review({ vendorTempId: tempUserId, status: 2, reject_reason: "not needed" });

    expect(res.status).toBe(200);
    const row = await db.one(`SELECT status, reject_reason FROM tbl_temp_user WHERE id = $1`, [tempUserId]);
    expect(Number(row.status)).toBe(2);
    expect(row.reject_reason).toBe("not needed");
  });

  it("REGRESSION: a nonexistent vendorTempId still answers 'user not exist'", async () => {
    const res = await review({ vendorTempId: GHOST_ID, status: 2, reject_reason: "x" });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("user not exist");
  });
});

// ---------------------------------------------------------------------------
//  SWEEP 3 — GET /api/v1/project/available-budget/:project_id
// ---------------------------------------------------------------------------

describe("SQLi — GET /project/available-budget/:project_id", () => {
  let projectId;

  beforeAll(async () => {
    const row = await db.one(
      `INSERT INTO tbl_projects (name, description, location, status, user_id, budget)
       VALUES ('SQLi Sweep Project', '', '', 1, $1, 5000) RETURNING id`,
      [BUYER]
    );
    projectId = row.id;
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_projects WHERE id = $1`, [projectId]);
  });

  const budget = async (segment) => {
    const client = await httpClient(BUYER);
    return client.get(`/api/v1/project/available-budget/${segment}`);
  };

  it("a crafted :project_id cannot sum every project's budget", async () => {
    const res = await budget(encodeURIComponent("-1 OR 1=1"));
    expect(res.status).not.toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("available_budget");
  });

  it("REGRESSION: the owner still reads the project's budget", async () => {
    const res = await budget(projectId);
    expect(res.status).toBe(200);
    expect(Number(res.body.data.total_budget)).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
//  SWEEP 4 — GET /api/v1/hospitality/rfq-hotels/:rfq_id
// ---------------------------------------------------------------------------

describe("SQLi — GET /hospitality/rfq-hotels/:rfq_id", () => {
  let rfqId;

  beforeAll(async () => {
    const { rfq_id } = await makeRFQ(db, { createdBy: BUYER, status: 1, is_published: 1 });
    rfqId = rfq_id;
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_rfq WHERE id = $1`, [rfqId]);
  });

  const hotels = async (segment) => {
    const client = await httpClient(BUYER);
    return client.get(`/api/v1/hospitality/rfq-hotels/${segment}`);
  };

  it("a crafted :rfq_id is rejected and leaks no hotel mapping", async () => {
    const res = await hotels(encodeURIComponent("-1 OR 1=1"));
    expect(res.status).not.toBe(200);
  });

  it("REGRESSION: a real rfq_id still resolves", async () => {
    const res = await hotels(rfqId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
  });
});

// ---------------------------------------------------------------------------
//  SWEEP 5 — POST /api/v1/admin/product/variant-vendor-mapping
// ---------------------------------------------------------------------------

describe("SQLi — POST /admin/product/variant-vendor-mapping", () => {
  let mappingId;
  let otherMappingId;
  let approveId;

  beforeAll(async () => {
    const mk = (vendorId) =>
      db.one(
        `INSERT INTO tbl_product_variant_vendor_mapping
           (product_variant_id, vendor_id, status, is_approved, created_by)
         VALUES (1, $1, true, false, $2) RETURNING id`,
        [vendorId, BUYER]
      );
    mappingId = (await mk(VENDOR_A)).id;
    otherMappingId = (await mk(VENDOR_B)).id;
    approveId = (
      await db.one(
        `INSERT INTO tbl_vendor_approve (vendor_approve, status) VALUES ('SQLi Sweep Approver', 1) RETURNING id`
      )
    ).id;
  });

  beforeEach(async () => {
    await db.none(`DELETE FROM tbl_product_variant_vendor_make WHERE variant_vendor_map_id = ANY($1::int[])`, [
      [mappingId, otherMappingId],
    ]);
    await db.none(
      `INSERT INTO tbl_product_variant_vendor_make (variant_vendor_map_id, make_name)
       VALUES ($1, 'Existing Make'), ($2, 'Other Mapping Make')`,
      [mappingId, otherMappingId]
    );
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_product_variant_vendor_make WHERE variant_vendor_map_id = ANY($1::int[])`, [
      [mappingId, otherMappingId],
    ]);
    await db.none(`DELETE FROM tbl_vendorapprove_product_mapping WHERE variant_vendor_mapping_id = ANY($1::int[])`, [
      [mappingId, otherMappingId],
    ]);
    await db.none(`DELETE FROM tbl_product_variant_vendor_mapping WHERE id = ANY($1::int[])`, [
      [mappingId, otherMappingId],
    ]);
    await db.none(`DELETE FROM tbl_vendor_approve WHERE id = $1`, [approveId]);
  });

  const makesFor = (id) =>
    db.any(
      `SELECT make_name FROM tbl_product_variant_vendor_make WHERE variant_vendor_map_id = $1 ORDER BY make_name`,
      [id]
    );

  it("a crafted mapping_id changes nothing — not this mapping's makes, not anyone else's", async () => {
    const client = await adminClient(BUYER);
    const res = await client.post("/api/v1/admin/product/variant-vendor-mapping").send({
      // `variant_vendor_map_id = <id>) OR (1=1` would have widened the make
      // read to every mapping in the table, so the delete-diff below would
      // have deleted other mappings' makes.
      mapping_id: `${mappingId}) OR (1=1`,
      approved_id: [approveId],
      make_list: ["Injected Make"],
    });

    expect(res.status).not.toBe(200);
    expect((await makesFor(mappingId)).map((m) => m.make_name)).toEqual(["Existing Make"]);
    expect((await makesFor(otherMappingId)).map((m) => m.make_name)).toEqual(["Other Mapping Make"]);
  });

  it("REGRESSION: a legitimate mapping_id still syncs makes for that mapping only", async () => {
    const client = await adminClient(BUYER);
    const res = await client.post("/api/v1/admin/product/variant-vendor-mapping").send({
      mapping_id: mappingId,
      approved_id: [approveId],
      make_list: ["Existing Make", "Added Make"],
    });

    expect(res.status).toBe(200);
    expect((await makesFor(mappingId)).map((m) => m.make_name)).toEqual(["Added Make", "Existing Make"]);
    expect((await makesFor(otherMappingId)).map((m) => m.make_name)).toEqual(["Other Mapping Make"]);
  });
});
