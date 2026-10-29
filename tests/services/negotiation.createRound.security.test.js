// negotiation.createRound.security.test.js
//
// Round creation (POST /negotiation/rounds) and submit-for-approval take an
// rfq_id from the request body. Proves:
//   1. a non-integer rfq_id is a 400 and never reaches SQL;
//   2. a buyer cannot create a round on another tenant's RFQ (403, no row);
//   3. a vendor token is refused by the route ACL.

import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { stampAdmin } from "../helpers/auth.js";

const HC_A = IDS.hospitality.A;
const HC_B = IDS.hospitality.B;
const A1 = IDS.hotels.A1;
const B1 = IDS.hotels.B1;

const ROLE_READ = 2; // Tender Creator: rfq.read, no negotiation.create
const ROLE_NEG = 8; // Commercial Negotiator N1 — negotiation.create + quote-compare.create, no rfq.read
const U_BUYER_A = 80991; // negotiator (HC_A, A1): negotiation.create, no rfq.read
const U_READER_A = 80992; // rfq.read only (HC_A, A1)

const PAST = new Date(Date.now() - 86_400_000).toISOString().replace("T", " ").slice(0, 19);
const FUTURE = () => new Date(Date.now() + 5 * 86_400_000).toISOString();

describe("Negotiation createRound / submit-for-approval — hardening", () => {
  let buyerA, readerA, vendor, rfqB, rfqA;

  beforeAll(async () => {
    for (const [uid, roleId] of [[U_BUYER_A, ROLE_NEG], [U_READER_A, ROLE_READ]]) {
      await db.none(
        `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
         VALUES ($1, $2, $3, 1, 2, $4, now(), now())
         ON CONFLICT (id) DO UPDATE SET user_type = 2, status = 1`,
        [uid, `CR Sec ${uid}`, `negcreatesec.${uid}@test.local`, IDS.companies.A]
      );
      await db.none(
        `INSERT INTO tbl_hospitality_user_mappings
           (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
         VALUES ($1, $2, $3, 1, $4)
         ON CONFLICT ON CONSTRAINT uq_hospitality_user_mapping DO NOTHING`,
        [uid, HC_A, A1, IDS.users.superAdmin]
      );
      await db.none(
        `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
         VALUES ($1, $2, $3, $4, NULL)`,
        [uid, roleId, HC_A, A1]
      );
    }
    rfqB = Number(
      (await makeRFQ(db, { createdBy: IDS.users.superAdmin, hospitality: HC_B, hotel: B1, title: "CRSEC-B" })).rfq_id
    );
    rfqA = Number(
      (await makeRFQ(db, { createdBy: IDS.users.superAdmin, hospitality: HC_A, hotel: A1, title: "CRSEC-A", bid_end_date: PAST })).rfq_id
    );
    buyerA = await httpClient(U_BUYER_A);
    readerA = await httpClient(U_READER_A);
    vendor = await httpClient(IDS.users.vendor_alpha);
  });

  afterAll(async () => {
    const users = [U_BUYER_A, U_READER_A];
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [users]);
    await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[])`, [users]);
    await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [users]);
    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE rfq_id = ANY($1::int[])`, [[rfqA, rfqB]]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [[rfqA, rfqB]]);
  });

  const body = (rfq_id) => ({
    rfq_id,
    end_date: FUTURE(),
    products: [{ rfq_product_id: 1, vendor_targets: [{ vendor_id: IDS.users.vendor_alpha, negotiation_fields: [] }] }],
  });

  test.each(["1 OR 1=1", "0 UNION SELECT 1", "abc", -5, 1.5])(
    "rejects a non-integer rfq_id %p with 400 and never reaches SQL",
    async (bad) => {
      const res = await buyerA.post("/api/v1/negotiation/rounds").send(body(bad));
      expect(res.status).toBe(400);
      expect(res.body.status).toBe(2);
      expect(res.body.message).toBe("rfq_id must be a positive integer");
    }
  );

  test("refuses a round on another tenant's RFQ with 403 and writes nothing", async () => {
    const before = await db.one(
      `SELECT count(*)::int AS n FROM tbl_negotiation_rounds WHERE rfq_id = $1`, [rfqB]
    );
    const res = await buyerA.post("/api/v1/negotiation/rounds").send(body(rfqB));
    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
    expect(res.body.message).toEqual(expect.stringMatching(/scope|permission|access/i));
    const after = await db.one(
      `SELECT count(*)::int AS n FROM tbl_negotiation_rounds WHERE rfq_id = $1`, [rfqB]
    );
    expect(after.n).toBe(before.n);
  });

  test("a read-only buyer is refused on another tenant's RFQ with 403 and writes nothing", async () => {
    const res = await readerA.post("/api/v1/negotiation/rounds").send(body(rfqB));
    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
    expect(res.body.message).toEqual(expect.stringMatching(/scope|permission|access/i));
    const n = await db.one(`SELECT count(*)::int AS n FROM tbl_negotiation_rounds WHERE rfq_id = $1`, [rfqB]);
    expect(n.n).toBe(0);
  });

  test("an in-scope RFQ passes the scope check", async () => {
    const res = await buyerA.post("/api/v1/negotiation/rounds").send(body(rfqA));
    // Past the scope check: the request now fails on the (deliberately absent) product.
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ status: 2, message: "Product 1 not found in this RFQ" });
  });

  test("submit-for-approval rejects a non-integer rfq_id with 400", async () => {
    const res = await buyerA.post("/api/v1/negotiation/quotes/submit-for-approval").send({
      rfq_id: "1 OR 1=1", rfq_product_id: 1, quote_ids: [1],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("rfq_id must be a positive integer");
  });

  test("submit-for-approval refuses another tenant's RFQ with 403", async () => {
    const res = await buyerA.post("/api/v1/negotiation/quotes/submit-for-approval").send({
      rfq_id: rfqB, rfq_product_id: 1, quote_ids: [1],
    });
    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
    expect(res.body.message).toEqual(expect.stringMatching(/scope|permission|access/i));
  });

  test("a vendor token cannot create a round", async () => {
    // Fixture users carry user_type NULL, which acl() refuses on its own. Make
    // the vendor a real vendor (3) so this test pins the route ACL itself.
    const prev = await stampAdmin(IDS.users.vendor_alpha, 3);
    try {
      const res = await vendor.post("/api/v1/negotiation/rounds").send(body(rfqA));
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ message: "Insufficient permissions" });
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [IDS.users.vendor_alpha, prev]);
    }
  });
});
