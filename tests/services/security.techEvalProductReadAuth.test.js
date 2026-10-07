// Product-level tech-evaluation reads must be authenticated and bound to the caller.
//
// Final-review fix wave (2026-10-06), same defect class as
// security.techEvalVendorResponseAuth.test.js, on sibling routes:
//   POST /rfq/get-clauses-of-product      - anonymous, vendor_id from the body
//   POST /rfq/get-tech-evaluation-result  - anonymous, vendor_id from the body
//   POST /rfq/get-deviation-previews      - authenticated, user_id from the body
// Rules: no credentials -> 401; a vendor is bound to itself (foreign id -> 403,
// missing id -> self) and must be mapped to the RFQ; a buyer must be able to
// read the parent RFQ. Also pins that add-vendor-response accepts the
// `deviation_text` the vendor wizard sends on a disagree row.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient, boundRequest } from "../helpers/http.js";
import { buildTestApp } from "../setup/app.js";
import { makeRFQ } from "../factories/rfq.js";
import { attachVendorToRfqProduct, seedTechEvalWithClauses } from "../factories/techEval.js";

const ADD = "/api/v1/rfq/add-vendor-response";
const GET = "/api/v1/rfq/get-vendor-responses";

const VENDOR_A = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;
const BUYER_IN_SCOPE = IDS.users.a1_proc_buyer;
const BUYER_OTHER_COMPANY = IDS.users.companyB_admin;
const PRODUCT_VARIANT = 1;
const TEST_USER_AGENT = "jest-test-agent";

// Fixture users leave user_type NULL (tests/fixtures/users.js). These
// endpoints branch on it, so give each caller its production persona for the
// duration of this file and restore the originals afterwards.
const PERSONAS = {
  [VENDOR_A]: 3,
  [VENDOR_B]: 3,
  [BUYER_IN_SCOPE]: 2,
  [BUYER_OTHER_COMPANY]: 2,
};
let originalUserTypes = [];

beforeAll(async () => {
  originalUserTypes = await db.any(
    `SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`,
    [Object.keys(PERSONAS).map(Number)]
  );
  for (const [id, userType] of Object.entries(PERSONAS)) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [Number(id), userType]);
  }
});

afterAll(async () => {
  for (const { id, user_type } of originalUserTypes) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [id, user_type]);
  }
  await closeDb();
});

const inserted = { rfqIds: [], tokenIds: [] };
beforeEach(() => {
  inserted.rfqIds = [];
  inserted.tokenIds = [];
});

afterEach(async () => {
  if (inserted.tokenIds.length) {
    await db.none(`DELETE FROM tbl_vendor_rfq_tokens_non_login WHERE id = ANY($1::int[])`, [inserted.tokenIds]);
  }
  if (!inserted.rfqIds.length) return;
  const teIds = (await db.any(
    `SELECT id FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1::int[])`,
    [inserted.rfqIds]
  )).map((r) => r.id);
  if (teIds.length) {
    const clauseSel = `SELECT id FROM tbl_rfq_product_tech_evaluation_clauses
                        WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[])`;
    await db.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation_vendors_response_files
        WHERE tbl_rfq_product_tech_evaluation_vendors_response_id IN (
          SELECT id FROM tbl_rfq_product_tech_evaluation_vendors_response
           WHERE tbl_rfq_product_tech_evaluation_clauses_id IN (${clauseSel}))`,
      [teIds]
    );
    await db.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation_vendors_response
        WHERE tbl_rfq_product_tech_evaluation_clauses_id IN (${clauseSel})`,
      [teIds]
    );
    await db.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation_clauses
        WHERE tbl_rfq_product_tech_evaluation_id = ANY($1::int[])`,
      [teIds]
    );
    await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation WHERE id = ANY($1::int[])`, [teIds]);
  }
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
});

/** A published RFQ at hotel A1 with one tech-eval clause, mapped to `vendors`. */
async function makeTechEvalRfq({ vendors }) {
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: BUYER_IN_SCOPE,
    status: 1,
    is_published: 1,
  });
  inserted.rfqIds.push(rfq_id);
  const product = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0)
     RETURNING id`,
    [rfq_id, PRODUCT_VARIANT]
  );
  for (const vendor_id of vendors) {
    await attachVendorToRfqProduct({ rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id });
  }
  const { clause_ids } = await seedTechEvalWithClauses({
    rfq_id,
    rfq_product_id: product.id,
    weightages: [100],
  });
  return { rfq_id, rfq_no, rfq_product_id: product.id, clause_id: clause_ids[0] };
}

async function seedResponse({ clause_id, vendor_id, vendor_response }) {
  await db.none(
    `INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response
       (tbl_rfq_product_tech_evaluation_clauses_id, vendor_id, vendor_response, "timestamp")
     VALUES ($1, $2, $3, NOW())`,
    [clause_id, vendor_id, vendor_response]
  );
}

async function responsesOf(clause_id, vendor_id) {
  return db.any(
    `SELECT vendor_response FROM tbl_rfq_product_tech_evaluation_vendors_response
      WHERE tbl_rfq_product_tech_evaluation_clauses_id = $1 AND vendor_id = $2`,
    [clause_id, vendor_id]
  );
}

function answer(rfq, extra = {}) {
  return {
    rfq_id: rfq.rfq_id,
    rfq_product_id: rfq.rfq_product_id,
    clause_id: rfq.clause_id,
    vendor_response: "I Agree",
    file_url: [],
    ...extra,
  };
}

const CLAUSES = "/api/v1/rfq/get-clauses-of-product";
const RESULT = "/api/v1/rfq/get-tech-evaluation-result";
const PREVIEWS = "/api/v1/rfq/get-deviation-previews";

describe.each([
  ["get-clauses-of-product", CLAUSES, (rfq, vendor_id) => ({ rfq_product_id: rfq.rfq_product_id, ...(vendor_id === undefined ? {} : { vendor_id }) })],
  ["get-tech-evaluation-result", RESULT, (rfq, vendor_id) => ({ rfq_id: rfq.rfq_id, rfq_product_id: rfq.rfq_product_id, ...(vendor_id === undefined ? {} : { vendor_id }) })],
  ["get-deviation-previews", PREVIEWS, (rfq, vendor_id) => ({ rfq_product_id: rfq.rfq_product_id, ...(vendor_id === undefined ? {} : { user_id: vendor_id }) })],
])("POST /rfq/%s", (_name, url, payload) => {
  it("rejects an unauthenticated caller with 401", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A] });
    const anon = await httpClient(null);

    const res = await anon.post(url).send(payload(rfq, VENDOR_A));

    expect(res.status).toBe(401);
  });

  it("rejects a vendor naming another vendor with 403", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A, VENDOR_B] });
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.post(url).send(payload(rfq, VENDOR_B));

    expect(res.status).toBe(403);
  });

  it("rejects a vendor that is not mapped to the RFQ with 403", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_B] });
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.post(url).send(payload(rfq, VENDOR_A));

    expect(res.status).toBe(403);
  });

  it("serves a mapped vendor for itself, with or without naming itself", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A] });
    const vendorA = await httpClient(VENDOR_A);

    const named = await vendorA.post(url).send(payload(rfq, VENDOR_A));
    const bare = await vendorA.post(url).send(payload(rfq));

    expect(named.status).toBe(200);
    expect(bare.status).toBe(200);
  });

  it("serves a buyer inside the RFQ's scope and refuses one outside it", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A] });
    const inScope = await httpClient(BUYER_IN_SCOPE);
    const outside = await httpClient(BUYER_OTHER_COMPANY);

    const ok = await inScope.post(url).send(payload(rfq, VENDOR_A));
    const denied = await outside.post(url).send(payload(rfq, VENDOR_A));

    expect(ok.status).toBe(200);
    expect(denied.status).toBe(403);
  });
});

describe("get-clauses-of-product / get-deviation-previews: a vendor only ever sees its own rows", () => {
  it("get-clauses-of-product with no vendor_id reports the caller's response, not B's", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A, VENDOR_B] });
    await seedResponse({ clause_id: rfq.clause_id, vendor_id: VENDOR_B, vendor_response: "I Agree" });
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.post(CLAUSES).send({ rfq_product_id: rfq.rfq_product_id });

    expect(res.status).toBe(200);
    expect(res.body.vendor_response).toBeFalsy();
  });
});

describe("POST /rfq/add-vendor-response deviation_text", () => {
  it("accepts the optional deviation_text the wizard sends on a disagree row", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A] });
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.post("/api/v1/rfq/add-vendor-response").send([
      answer(rfq, { vendor_id: VENDOR_A, vendor_response: "I Dont Agree", deviation_text: "  Cannot meet this spec  " }),
    ]);

    expect(res.status).toBe(200);
    expect(await responsesOf(rfq.clause_id, VENDOR_A)).toEqual([{ vendor_response: "I Dont Agree" }]);
  });

  it("still rejects an over-long deviation_text", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A] });
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.post("/api/v1/rfq/add-vendor-response").send([
      answer(rfq, { vendor_id: VENDOR_A, vendor_response: "I Dont Agree", deviation_text: "x".repeat(2001) }),
    ]);

    expect(res.status).toBe(400);
    expect(await responsesOf(rfq.clause_id, VENDOR_A)).toEqual([]);
  });
});
