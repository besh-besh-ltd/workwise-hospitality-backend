// WH-67 regression: post-payment "auto-join open RFQs" must survive an RFQ
// whose `bid_end_date` is an EMPTY STRING.
//
// Production incident (P1): tbl_rfq.bid_end_date is a TEXT column. RFQ 744
// (rfq_no 536286) was published with bid_end_date = '' (empty string, NOT
// null). The backfill query in
// `hospitalityModel.getMatchingOpenRfqsForVendor` cast that column with no
// guard:
//
//     AND r.bid_end_date::timestamp > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')
//
// Because that row satisfies `status = 1 AND is_published = 1`, the cast was
// evaluated on it and the WHOLE query aborted with
// `invalid input syntax for type timestamp: ""`. Every newly registered
// vendor therefore got a 500 on
// `GET /hospitality/vendor/matching-open-rfqs`, the frontend swallowed it,
// and the vendor landed on an empty dashboard with zero RFQs.
//
// The same unguarded cast lives in `hospitalityController.joinOpenRfqs`
// (scoped by `WHERE id = ANY($1::int[])`), so it only detonates when the
// poison id is passed in — which is exactly what the data-repair runbook
// does. This suite passes the poison id to `join-open-rfqs` on purpose.
//
// THE EMPTY-bid_end_date FIXTURE ROW IS THE REGRESSION GUARD. Remove it and
// this suite passes against the buggy code.
//
// Semantics locked in by these tests: an empty deadline EXCLUDES the RFQ
// from auto-join (conservative — we do not auto-join vendors to an RFQ that
// has no deadline). Note this deliberately differs from the vendor *listing*
// query (`rfqModel.getRfqByUser`) which treats bid_end_date = '' as open.
//
// Isolation: Pattern B (commit + cleanup) — the production model queries `db`
// directly and the flow is exercised over real HTTP.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { makeRFQ } from "../factories/rfq.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";

// Dedicated "just registered" vendor. Sits in the vendor-user range
// (80101..80199) but outside the fixture block (80101..80105) so no other
// suite touches it.
const NEW_VENDOR_ID = 80151;

const created = {
  rfqIds: [],
  variantMappingIds: [],
  subscriptionIds: [],
};

let variantId;
let poisonRfq; // published + active, bid_end_date = ''  ← the regression guard
let validRfq; // published + active, bid_end_date = future

async function addSub(itemType, itemId) {
  const row = await db.one(
    `INSERT INTO tbl_vendor_hotel_category_subscription
       (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
     VALUES ($1, $2, $3, 500,
             (now() - interval '30 days')::date,
             (now() + interval '335 days')::date,
             'active')
     RETURNING id`,
    [NEW_VENDOR_ID, itemType, itemId]
  );
  created.subscriptionIds.push(row.id);
  return row.id;
}

async function addRfqProduct(rfqId) {
  await db.none(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
     VALUES ($1, '', '0', '', '', $2, 1)`,
    [rfqId, variantId]
  );
}

async function mapRfqToHotel(rfqId, hotelId) {
  await db.none(
    `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by)
     VALUES ($1, $2, $3)
     ON CONFLICT ON CONSTRAINT uq_rfq_hotel_mapping DO NOTHING`,
    [rfqId, hotelId, IDS.users.a1_proc_buyer]
  );
}

beforeAll(async () => {
  // A real seeded variant whose product sits in BEVERAGES (215) — the
  // category the new vendor will subscribe to.
  const v = await db.one(
    `SELECT pv.id
       FROM tbl_product_variant pv
       JOIN tbl_product_categories pc ON pc.product_id = pv.product_id
      WHERE pc.category_id = $1
      ORDER BY pv.id
      LIMIT 1`,
    [TEST_CATEGORIES.beverages]
  );
  variantId = v.id;

  // --- the "just registered + just paid" vendor -----------------------------
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, company_id, created_at, updated_at)
     VALUES ($1, 'Post-Payment New Vendor', 'postpay.new@vendor.test', 1, $2, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [NEW_VENDOR_ID, IDS.companies.vendorAlpha]
  );

  const mapping = await db.one(
    `INSERT INTO tbl_product_variant_vendor_mapping
       (product_variant_id, vendor_id, status, is_approved, created_by, created_at, updated_at)
     VALUES ($1, $2, true, true, $2, now(), now())
     RETURNING id`,
    [variantId, NEW_VENDOR_ID]
  );
  created.variantMappingIds.push(mapping.id);

  await addSub("category", TEST_CATEGORIES.beverages);
  await addSub("hotel", IDS.hotels.A1);

  // --- RFQ 1: THE POISON ROW (bid_end_date = '') ---------------------------
  // Published + active, matching products + hotel, so it is a genuine
  // candidate row and the cast is definitely evaluated on it.
  poisonRfq = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    bid_end_date: "",
    title: "WH-67 poison RFQ (empty bid_end_date)",
  });
  created.rfqIds.push(poisonRfq.rfq_id);
  await addRfqProduct(poisonRfq.rfq_id);
  await mapRfqToHotel(poisonRfq.rfq_id, IDS.hotels.A1);

  // --- RFQ 2: the legitimately open RFQ the vendor should be joined to ------
  const future = new Date(Date.now() + 14 * 86400_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  validRfq = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    bid_end_date: future,
    title: "WH-67 valid open RFQ",
  });
  created.rfqIds.push(validRfq.rfq_id);
  await addRfqProduct(validRfq.rfq_id);
  await mapRfqToHotel(validRfq.rfq_id, IDS.hotels.A1);
});

afterAll(async () => {
  if (created.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
    await db.none(
      `DELETE FROM tbl_vendor_rfq_tokens_non_login
        WHERE vendor_id = $1
          AND rfq_no IN (SELECT rfq_no FROM tbl_rfq WHERE id = ANY($2::int[]))`,
      [NEW_VENDOR_ID, created.rfqIds]
    );
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [created.rfqIds]);
  }
  if (created.variantMappingIds.length) {
    await db.none(`DELETE FROM tbl_product_variant_vendor_mapping WHERE id = ANY($1::int[])`, [
      created.variantMappingIds,
    ]);
  }
  if (created.subscriptionIds.length) {
    await db.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE id = ANY($1::int[])`, [
      created.subscriptionIds,
    ]);
  }
  await db.none(`DELETE FROM tbl_users WHERE id = $1`, [NEW_VENDOR_ID]);
  await closeDb();
});

describe("WH-67 post-payment auto-join — empty bid_end_date must not poison the backfill", () => {
  it("GET /hospitality/vendor/matching-open-rfqs returns 200 (not 500) and includes the open RFQ", async () => {
    const client = await httpClient(NEW_VENDOR_ID);
    const res = await client.get("/api/v1/hospitality/vendor/matching-open-rfqs");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    const ids = (res.body.data?.rfqs ?? []).map((r) => Number(r.rfq_id));
    expect(ids).toContain(validRfq.rfq_id);
  });

  it("excludes the RFQ whose bid_end_date is an empty string (no deadline ⇒ no auto-join)", async () => {
    const client = await httpClient(NEW_VENDOR_ID);
    const res = await client.get("/api/v1/hospitality/vendor/matching-open-rfqs");

    expect(res.status).toBe(200);
    const ids = (res.body.data?.rfqs ?? []).map((r) => Number(r.rfq_id));
    expect(ids).not.toContain(poisonRfq.rfq_id);
  });

  it("POST /hospitality/vendor/join-open-rfqs survives the poison id and writes vendor rows for the open RFQ", async () => {
    const client = await httpClient(NEW_VENDOR_ID);
    // Deliberately include the poison id: the data-repair runbook posts the
    // ids returned by the GET, and any caller may pass a stale one. The
    // controller's own cast must be guarded too.
    const res = await client
      .post("/api/v1/hospitality/vendor/join-open-rfqs")
      .send({ rfq_ids: [validRfq.rfq_id, poisonRfq.rfq_id] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.rfqs.map((r) => Number(r.rfq_id))).toContain(validRfq.rfq_id);

    const rows = await db.any(
      `SELECT rfq_id FROM tbl_rfq_product_vendors WHERE user_id = $1 AND rfq_id = ANY($2::int[])`,
      [NEW_VENDOR_ID, [validRfq.rfq_id, poisonRfq.rfq_id]]
    );
    const joinedIds = rows.map((r) => Number(r.rfq_id));
    expect(joinedIds).toContain(validRfq.rfq_id);
    expect(joinedIds).not.toContain(poisonRfq.rfq_id);
  });

  it("the joined RFQ then shows up on the vendor's dashboard (POST /rfq/getMyRfq)", async () => {
    const client = await httpClient(NEW_VENDOR_ID);
    const res = await client.post("/api/v1/rfq/getMyRfq").send({ page: 1, limit: 50 });

    expect(res.status).toBe(200);
    const ids = (res.body.data ?? []).map((r) => Number(r.rfq_id ?? r.id));
    expect(ids).toContain(validRfq.rfq_id);
  });
});
