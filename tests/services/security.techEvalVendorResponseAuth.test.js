// Tech-eval vendor responses must be written and read only by their owner.
//
// P0 (2026-10-06). Both endpoints sat behind `noLogin.customer_auth`, which
// lets a request with NO Authorization header through, and the write took the
// vendor id from each body element:
//
//   POST /rfq/add-vendor-response   -> rfqModel.addVendorResponse writes
//        tbl_rfq_product_tech_evaluation_vendors_response with body.vendor_id
//   POST /rfq/get-vendor-responses  -> reads any vendor's answers by body.vendor_id
//
// So anyone on the internet could overwrite or read any vendor's clause answers.
//
// The rules these tests pin:
//   1. Both endpoints require an authenticated caller (401 otherwise).
//   2. Only a vendor may write, only its own rows, and only on RFQs it is
//      mapped to. A foreign vendor_id is a visible 403, never a silent rewrite,
//      and a rejected batch writes nothing.
//   3. A vendor reads only its own answers. A buyer reads a vendor's answers
//      only when the RFQ is inside the buyer's RBAC scope (the buyer
//      technical-evaluation screen, ClauseProductItem.js, depends on this).
//   4. An emailed-link vendor (guest JWT from /users/verify-vendor-token) can
//      still submit its own answers.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import rfqModel from "../../app/models/rfqModel.js";
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
      `DELETE FROM tbl_rfq_product_tech_evaluation_comments
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

describe("POST /rfq/add-vendor-response", () => {
  it("(a) rejects an unauthenticated caller with 401 and writes nothing", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A, VENDOR_B] });
    const anon = await httpClient(null);

    const res = await anon.post(ADD).send([answer(rfq, { vendor_id: VENDOR_B })]);

    expect(res.status).toBe(401);
    expect(await responsesOf(rfq.clause_id, VENDOR_B)).toEqual([]);
  });

  it("(b) rejects a batch carrying another vendor's id with 403 and writes nothing", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A, VENDOR_B] });
    await seedResponse({ clause_id: rfq.clause_id, vendor_id: VENDOR_B, vendor_response: "I Agree" });
    const vendorA = await httpClient(VENDOR_A);

    // One honest element first, so a partial write would be detectable.
    const res = await vendorA.post(ADD).send([
      answer(rfq, { vendor_id: VENDOR_A }),
      answer(rfq, { vendor_id: VENDOR_B, vendor_response: "I Dont Agree" }),
    ]);

    expect(res.status).toBe(403);
    expect(res.body.status).toBe(0);
    expect(await responsesOf(rfq.clause_id, VENDOR_B)).toEqual([{ vendor_response: "I Agree" }]);
    expect(await responsesOf(rfq.clause_id, VENDOR_A)).toEqual([]);
  });

  it("(c) accepts the caller's own answer on an RFQ it is mapped to", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A] });
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.post(ADD).send([answer(rfq, { vendor_id: VENDOR_A })]);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(await responsesOf(rfq.clause_id, VENDOR_A)).toEqual([{ vendor_response: "I Agree" }]);
  });

  it("(c2) binds an element without vendor_id to the caller", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A] });
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.post(ADD).send([answer(rfq)]);

    expect(res.status).toBe(200);
    expect(await responsesOf(rfq.clause_id, VENDOR_A)).toEqual([{ vendor_response: "I Agree" }]);
  });

  it("(d) rejects a clause on an RFQ the caller is not mapped to with 403", async () => {
    const mine = await makeTechEvalRfq({ vendors: [VENDOR_A] });
    const notMine = await makeTechEvalRfq({ vendors: [VENDOR_B] });
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.post(ADD).send([
      answer(mine, { vendor_id: VENDOR_A }),
      answer(notMine, { vendor_id: VENDOR_A }),
    ]);

    expect(res.status).toBe(403);
    expect(await responsesOf(mine.clause_id, VENDOR_A)).toEqual([]);
    expect(await responsesOf(notMine.clause_id, VENDOR_A)).toEqual([]);
  });

  it("rejects a buyer caller with 403", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_B] });
    const buyer = await httpClient(BUYER_IN_SCOPE);

    const res = await buyer.post(ADD).send([answer(rfq, { vendor_id: VENDOR_B })]);

    expect(res.status).toBe(403);
    expect(await responsesOf(rfq.clause_id, VENDOR_B)).toEqual([]);
  });

  it("accepts an emailed-link vendor's own answer via the guest JWT", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A] });
    const app = await buildTestApp();
    const linkToken = String(Date.now()) + String(Math.floor(Math.random() * 1000));
    const tok = await db.one(
      `INSERT INTO tbl_vendor_rfq_tokens_non_login (token, vendor_id, rfq_no)
       VALUES ($1, $2, $3) RETURNING id`,
      [linkToken, VENDOR_A, rfq.rfq_no]
    );
    inserted.tokenIds.push(tok.id);

    const verify = await request(app)
      .post("/api/v1/users/verify-vendor-token")
      .set("User-Agent", TEST_USER_AGENT)
      .send({ token: linkToken });
    expect(verify.status).toBe(200);
    const guestJwt = verify.body.data.token;

    const res = await request(app)
      .post(ADD)
      .set("Authorization", `Bearer ${guestJwt}`)
      .set("User-Agent", TEST_USER_AGENT)
      .send([answer(rfq, { vendor_id: VENDOR_A })]);

    expect(res.status).toBe(200);
    expect(await responsesOf(rfq.clause_id, VENDOR_A)).toEqual([{ vendor_response: "I Agree" }]);
  });
});

describe("POST /rfq/get-vendor-responses", () => {
  const readBody = (rfq, vendor_id) => ({
    rfq_id: rfq.rfq_id,
    rfq_product_id: rfq.rfq_product_id,
    ...(vendor_id === undefined ? {} : { vendor_id }),
  });

  it("(f) rejects an unauthenticated caller with 401", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_B] });
    await seedResponse({ clause_id: rfq.clause_id, vendor_id: VENDOR_B, vendor_response: "I Agree" });
    const anon = await httpClient(null);

    const res = await anon.post(GET).send(readBody(rfq, VENDOR_B));

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body ?? {})).not.toContain("I Agree");
  });

  it("(e) rejects a vendor reading another vendor's answers with 403", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A, VENDOR_B] });
    await seedResponse({ clause_id: rfq.clause_id, vendor_id: VENDOR_B, vendor_response: "B secret" });
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.post(GET).send(readBody(rfq, VENDOR_B));

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("B secret");
  });

  it("lets a vendor read its own answers, with or without vendor_id", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A, VENDOR_B] });
    await seedResponse({ clause_id: rfq.clause_id, vendor_id: VENDOR_A, vendor_response: "A answer" });
    await seedResponse({ clause_id: rfq.clause_id, vendor_id: VENDOR_B, vendor_response: "B secret" });
    const vendorA = await httpClient(VENDOR_A);

    for (const body of [readBody(rfq, VENDOR_A), readBody(rfq)]) {
      const res = await vendorA.post(GET).send(body);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(1);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].vendor_response).toBe("A answer");
      expect(JSON.stringify(res.body)).not.toContain("B secret");
    }
  });

  it("rejects a vendor reading an RFQ it is not mapped to with 403", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_B] });
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.post(GET).send(readBody(rfq, VENDOR_A));

    expect(res.status).toBe(403);
  });

  it("lets an in-scope buyer read a vendor's answers (buyer tech-eval screen)", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_B] });
    await seedResponse({ clause_id: rfq.clause_id, vendor_id: VENDOR_B, vendor_response: "B answer" });
    const buyer = await httpClient(BUYER_IN_SCOPE);

    const res = await buyer.post(GET).send(readBody(rfq, VENDOR_B));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data[0].vendor_response).toBe("B answer");
  });

  it("rejects a buyer whose scope does not cover the RFQ with 403", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_B] });
    await seedResponse({ clause_id: rfq.clause_id, vendor_id: VENDOR_B, vendor_response: "B secret" });
    const outsider = await httpClient(BUYER_OTHER_COMPANY);

    const res = await outsider.post(GET).send(readBody(rfq, VENDOR_B));

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("B secret");
  });
});

describe("POST /rfq/add-vendor-response persists the disagree reason to the clause chat", () => {
  const commentsOf = (clause_id) =>
    db.any(
      `SELECT sender_id, receiver_id, text FROM tbl_rfq_product_tech_evaluation_comments
        WHERE tbl_rfq_product_tech_evaluation_clauses_id = $1 ORDER BY id`,
      [clause_id]
    );

  it("stores a trimmed disagree reason from the vendor to the RFQ creator, visible in deviation previews", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A] });
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.post(ADD).send([
      answer(rfq, { vendor_response: "I Dont Agree", deviation_text: "  Cannot meet this spec  " }),
    ]);

    expect(res.status).toBe(200);
    expect(await commentsOf(rfq.clause_id)).toEqual([
      { sender_id: VENDOR_A, receiver_id: BUYER_IN_SCOPE, text: "Cannot meet this spec" },
    ]);
    const previews = await vendorA.post("/api/v1/rfq/get-deviation-previews").send({ rfq_product_id: rfq.rfq_product_id });
    expect(previews.status).toBe(200);
    expect(JSON.stringify(previews.body)).toContain("Cannot meet this spec");
  });

  it("stores no comment for an agree row, even when text is sent", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A] });
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.post(ADD).send([answer(rfq, { deviation_text: "ignored" })]);

    expect(res.status).toBe(200);
    expect(await commentsOf(rfq.clause_id)).toEqual([]);
  });

  it("stores no comment for a disagree row with blank text", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A] });
    const vendorA = await httpClient(VENDOR_A);

    await vendorA.post(ADD).send([answer(rfq, { vendor_response: "I Dont Agree", deviation_text: "   " })]);

    expect(await commentsOf(rfq.clause_id)).toEqual([]);
  });

  it("does not duplicate the comment when the same reason is re-submitted, but stores a changed one", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A] });
    const vendorA = await httpClient(VENDOR_A);
    const send = (text) =>
      vendorA.post(ADD).send([answer(rfq, { vendor_response: "I Dont Agree", deviation_text: text })]);

    expect((await send("Cannot meet this spec")).status).toBe(200);
    expect((await send("  Cannot meet this spec ")).status).toBe(200);
    expect(await commentsOf(rfq.clause_id)).toHaveLength(1);

    expect((await send("Can meet with a 2 week delay")).status).toBe(200);
    expect((await commentsOf(rfq.clause_id)).map((c) => c.text)).toEqual([
      "Cannot meet this spec",
      "Can meet with a 2 week delay",
    ]);
  });

  it("re-posts the same reason when the buyer replied in between", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A] });
    const vendorA = await httpClient(VENDOR_A);
    const send = () =>
      vendorA.post(ADD).send([answer(rfq, { vendor_response: "I Dont Agree", deviation_text: "Cannot meet this spec" })]);

    await send();
    await db.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation_comments
         (tbl_rfq_product_tech_evaluation_clauses_id, sender_id, receiver_id, text, "timestamp")
       VALUES ($1, $2, $3, 'Please reconsider', NOW() + interval '1 second')`,
      [rfq.clause_id, BUYER_IN_SCOPE, VENDOR_A]
    );
    expect((await send()).status).toBe(200);

    expect((await commentsOf(rfq.clause_id)).map((c) => c.text)).toEqual([
      "Cannot meet this spec",
      "Please reconsider",
      "Cannot meet this spec",
    ]);
  });

  it("leaves no comment when an unmapped vendor is refused with 403", async () => {
    const notMine = await makeTechEvalRfq({ vendors: [VENDOR_B] });
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.post(ADD).send([
      answer(notMine, { vendor_response: "I Dont Agree", deviation_text: "Cannot meet this spec" }),
    ]);

    expect(res.status).toBe(403);
    expect(await commentsOf(notMine.clause_id)).toEqual([]);
  });

  it("model transaction: a failure on element 2 rolls back element 1's response and comment", async () => {
    const rfq = await makeTechEvalRfq({ vendors: [VENDOR_A] });

    await expect(
      rfqModel.addVendorResponse([
        { ...answer(rfq), vendor_id: VENDOR_A, vendor_response: "I Dont Agree", deviation_text: "Cannot meet this spec" },
        { ...answer(rfq), vendor_id: 2147483000 },
      ])
    ).rejects.toMatchObject({ status: 0 });

    expect(await responsesOf(rfq.clause_id, VENDOR_A)).toEqual([]);
    expect(await commentsOf(rfq.clause_id)).toEqual([]);
  });
});
